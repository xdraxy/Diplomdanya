"""
SyncPlay — синхронное прослушивание музыки в комнатах.
Бэкенд на FastAPI с нативными WebSocket-соединениями.
"""
import asyncio
import json
import logging
import os
import secrets
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from fastapi import (
    APIRouter,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, Response, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3
from starlette.middleware.cors import CORSMiddleware

from auth import build_auth_router, make_auth_dependencies, setup_auth

UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 МБ
ROOM_CLEANUP_DELAY = 300  # 5 минут
CHAT_HISTORY_MAX = 200
ROOM_CODE_LENGTH = 6
FILE_ID_LENGTH = 12

mongo_url = os.environ["MONGO_URL"]
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ["DB_NAME"]]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("syncplay")

app = FastAPI()
api_router = APIRouter(prefix="/api")


# =========================================================================
# Room state
# =========================================================================
class Room:
    """In-memory состояние комнаты."""

    def __init__(self, code: str):
        self.code: str = code
        self.track: Optional[dict] = None
        self.position: float = 0.0
        self.play_started_at: Optional[float] = None
        self.playing: bool = False
        self.volume: float = 0.7
        self.connections: Dict[str, WebSocket] = {}
        self.participants: Dict[str, str] = {}
        self.last_uploader: Optional[str] = None
        self.chat_history: List[dict] = []
        self.queue: List[dict] = []  # очередь треков
        self.created_at: float = time.time()

    def current_position(self) -> float:
        if self.track is None:
            return 0.0
        if self.playing and self.play_started_at is not None:
            pos = self.position + (time.time() - self.play_started_at)
            duration = self.track.get("duration") or 0
            if duration and pos > duration:
                return duration
            return pos
        return self.position

    def state_dict(self) -> dict:
        track = None
        if self.track:
            track = {
                "url": self.track["url"],
                "title": self.track["title"],
                "artist": self.track["artist"],
                "duration": self.track["duration"],
                "uploaded_by": self.track["uploaded_by"],
                "filename": self.track["filename"],
                "cover_url": self.track.get("cover_url"),
            }
        return {
            "code": self.code,
            "track": track,
            "position": self.current_position(),
            "playing": self.playing,
            "volume": self.volume,
            "server_time": time.time(),
            "participants": list(self.participants.values()),
            "last_uploader": self.last_uploader,
            "queue": [
                {
                    "id": q["id"],
                    "title": q["title"],
                    "artist": q["artist"],
                    "duration": q["duration"],
                    "added_by": q.get("uploaded_by"),
                }
                for q in self.queue
            ],
        }


rooms: Dict[str, Room] = {}
cleanup_tasks: Dict[str, asyncio.Task] = {}


# =========================================================================
# Helpers
# =========================================================================
def generate_room_code() -> str:
    """6-значный код комнаты (криптографически безопасный)."""
    while True:
        code = "".join(secrets.choice(string.digits) for _ in range(ROOM_CODE_LENGTH))
        if code not in rooms:
            return code


def generate_file_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(FILE_ID_LENGTH))


def safe_str(value) -> str:
    if value is None:
        return ""
    try:
        return str(value).strip()
    except Exception:
        return ""


def _extract_id3_tags(file_path: Path) -> dict:
    """Достаём title/artist/duration из MP3-метаданных."""
    result = {"title": None, "artist": None, "duration": 0.0}
    try:
        audio = MP3(str(file_path))
        result["duration"] = float(audio.info.length or 0)
        tags = audio.tags
        if tags:
            if "TIT2" in tags and tags["TIT2"].text:
                t = safe_str(tags["TIT2"].text[0])
                if t:
                    result["title"] = t
            if "TPE1" in tags and tags["TPE1"].text:
                a = safe_str(tags["TPE1"].text[0])
                if a:
                    result["artist"] = a
    except Exception as e:
        logger.warning(f"MP3 metadata read failed: {e}")
    return result


def _extract_cover_art(file_path: Path) -> Optional[str]:
    """Извлекаем APIC-обложку, сохраняем рядом с MP3, возвращаем URL."""
    try:
        id3 = ID3(str(file_path))
    except ID3NoHeaderError:
        return None
    except Exception as e:
        logger.warning(f"ID3 read failed: {e}")
        return None

    apic_frames = id3.getall("APIC")
    if not apic_frames:
        return None

    apic = apic_frames[0]
    mime = apic.mime or "image/jpeg"
    ext = "png" if "png" in mime else "jpg"
    cover_path = file_path.with_suffix(f".cover.{ext}")
    try:
        with open(cover_path, "wb") as f:
            f.write(apic.data)
    except Exception as e:
        logger.warning(f"Cover write failed: {e}")
        return None
    return f"/api/files/{cover_path.name}"


def extract_metadata(file_path: Path, fallback_title: str) -> dict:
    tags = _extract_id3_tags(file_path)
    cover_url = _extract_cover_art(file_path)
    return {
        "title": tags["title"] or fallback_title,
        "artist": tags["artist"] or "Неизвестный исполнитель",
        "duration": tags["duration"],
        "cover_url": cover_url,
    }


def remove_track_files(track: dict) -> None:
    for key in ("file_path", "cover_path"):
        p = track.get(key)
        if p:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:
                pass


async def broadcast(code: str, message: dict, exclude: Optional[str] = None) -> None:
    room = rooms.get(code)
    if not room:
        return
    dead = []
    for ws_id, ws in list(room.connections.items()):
        if ws_id == exclude:
            continue
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws_id)
    for d in dead:
        room.connections.pop(d, None)
        room.participants.pop(d, None)


async def cleanup_room_later(code: str) -> None:
    try:
        await asyncio.sleep(ROOM_CLEANUP_DELAY)
        room = rooms.get(code)
        if room and len(room.connections) == 0:
            if room.track:
                remove_track_files(room.track)
            rooms.pop(code, None)
            cleanup_tasks.pop(code, None)
            try:
                await db.rooms.delete_one({"code": code})
            except Exception as e:
                logger.warning(f"Mongo cleanup failed: {e}")
            logger.info(f"Room {code} cleaned up after inactivity")
    except asyncio.CancelledError:
        pass


# =========================================================================
# Upload helpers
# =========================================================================
def _validate_upload_filename(filename: str) -> None:
    if not filename.lower().endswith(".mp3"):
        raise HTTPException(status_code=400, detail="Принимаются только MP3 файлы")


async def _read_upload_to_disk(file: UploadFile, dest: Path) -> None:
    """Читаем upload по чанкам с проверкой лимита и пишем в файл."""
    total = 0
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_SIZE:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413, detail="Файл слишком большой (макс 20 МБ)"
                )
            out.write(chunk)


def _build_track_dict(
    file_path: Path,
    filename: str,
    name: str,
    meta: dict,
) -> dict:
    cover_path = None
    if meta["cover_url"]:
        cover_path = str(UPLOAD_DIR / Path(meta["cover_url"]).name)
    return {
        "file_path": str(file_path),
        "cover_path": cover_path,
        "url": f"/api/files/{file_path.name}",
        "title": meta["title"],
        "artist": meta["artist"],
        "duration": meta["duration"],
        "uploaded_by": name,
        "filename": filename,
        "cover_url": meta["cover_url"],
    }


# =========================================================================
# REST
# =========================================================================
@api_router.get("/")
async def root():
    return {"app": "syncplay", "ok": True}


@api_router.post("/rooms")
async def create_room():
    code = generate_room_code()
    rooms[code] = Room(code)
    try:
        await db.rooms.insert_one(
            {"code": code, "created_at": datetime.now(timezone.utc).isoformat()}
        )
    except Exception as e:
        logger.warning(f"Mongo insert failed: {e}")
    return {"code": code}


@api_router.get("/rooms/{code}")
async def get_room(code: str):
    if code not in rooms:
        raise HTTPException(status_code=404, detail="Комната не найдена")
    return rooms[code].state_dict()


@api_router.post("/rooms/{code}/upload")
async def upload_track(
    code: str,
    name: str = Form(...),
    file: UploadFile = File(...),
    to_queue: bool = False,
):
    if code not in rooms:
        raise HTTPException(status_code=404, detail="Комната не найдена")

    filename = file.filename or "track.mp3"
    _validate_upload_filename(filename)

    file_path = UPLOAD_DIR / f"{code}_{generate_file_id()}.mp3"
    await _read_upload_to_disk(file, file_path)

    room = rooms[code]

    fallback_title = filename.rsplit(".", 1)[0]
    meta = extract_metadata(file_path, fallback_title)
    track = _build_track_dict(file_path, filename, name, meta)
    # уникальный id для управления в очереди
    track["id"] = generate_file_id()

    # Если у комнаты УЖЕ есть текущий трек И запрошено добавление в очередь —
    # кладём в очередь, текущий не трогаем.
    if to_queue and room.track is not None:
        room.queue.append(track)
        await broadcast(code, {"type": "queue_update", "state": room.state_dict()})
        return {"ok": True, "queued": True, "track": track}

    # Иначе — заменяем текущий трек (старый удаляем с диска).
    if room.track:
        remove_track_files(room.track)
    room.track = track
    room.last_uploader = name
    room.position = 0.0
    room.play_started_at = None
    room.playing = False

    await broadcast(code, {"type": "track_change", "state": room.state_dict()})
    return {"ok": True, "queued": False, "track": room.state_dict()["track"]}


@api_router.get("/files/{filename}")
async def serve_file(filename: str, request: Request):
    """
    Раздача статики с поддержкой HTTP Range — критически важно для
    корректной перемотки в <audio>. Без 206 Partial Content браузер
    не может корректно сикать по треку.
    """
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Недопустимое имя файла")
    file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден")

    media = "audio/mpeg"
    if filename.endswith(".jpg") or filename.endswith(".jpeg"):
        media = "image/jpeg"
    elif filename.endswith(".png"):
        media = "image/png"

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(
            str(file_path),
            media_type=media,
            headers={"Accept-Ranges": "bytes"},
        )

    # Парсим "bytes=start-end" (end опционален)
    try:
        units, _, rng = range_header.partition("=")
        if units.strip().lower() != "bytes":
            raise ValueError("invalid unit")
        start_s, _, end_s = rng.strip().partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        if start < 0 or end < start or end >= file_size:
            raise ValueError("invalid range")
    except ValueError:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    length = end - start + 1

    def stream():
        chunk_size = 64 * 1024
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        stream(),
        status_code=206,
        media_type=media,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
        },
    )


# =========================================================================
# WebSocket message handlers
# =========================================================================
async def _handle_join(room: Room, ws_id: str, websocket: WebSocket, data: dict) -> str:
    name = safe_str(data.get("name", "Гость"))[:50] or "Гость"
    room.connections[ws_id] = websocket
    room.participants[ws_id] = name
    await websocket.send_json(
        {
            "type": "init",
            "state": room.state_dict(),
            "chat": room.chat_history[-50:],
            "you": name,
        }
    )
    await broadcast(
        room.code,
        {
            "type": "participants",
            "participants": list(room.participants.values()),
            "joined": name,
        },
        exclude=ws_id,
    )
    return name


async def _handle_play(room: Room, data: dict) -> None:
    if room.track is None:
        return
    if not room.playing:
        room.position = float(data.get("position", room.current_position()))
        room.play_started_at = time.time()
        room.playing = True
    await broadcast(room.code, {"type": "state", "state": room.state_dict()})


async def _handle_pause(room: Room) -> None:
    if room.track is None:
        return
    if room.playing:
        room.position = room.current_position()
        room.playing = False
        room.play_started_at = None
    await broadcast(room.code, {"type": "state", "state": room.state_dict()})


async def _handle_seek(room: Room, data: dict) -> None:
    if room.track is None:
        return
    pos = float(data.get("position", 0.0))
    duration = room.track.get("duration") or 0
    if duration and pos > duration:
        pos = duration
    if pos < 0:
        pos = 0
    room.position = pos
    if room.playing:
        room.play_started_at = time.time()
    await broadcast(room.code, {"type": "state", "state": room.state_dict()})


async def _handle_volume(room: Room, name: Optional[str], data: dict) -> None:
    vol = max(0.0, min(1.0, float(data.get("volume", 0.7))))
    room.volume = vol
    await broadcast(
        room.code,
        {"type": "volume", "volume": room.volume, "by": name or "Гость"},
    )


async def _handle_chat(room: Room, name: Optional[str], data: dict) -> None:
    text = safe_str(data.get("text", ""))[:500]
    if not text:
        return
    msg = {
        "type": "chat",
        "name": name or "Гость",
        "text": text,
        "ts": time.time(),
    }
    room.chat_history.append(msg)
    if len(room.chat_history) > CHAT_HISTORY_MAX:
        room.chat_history = room.chat_history[-CHAT_HISTORY_MAX:]
    await broadcast(room.code, msg)


async def _handle_sync_request(room: Room, websocket: WebSocket) -> None:
    await websocket.send_json({"type": "sync", "state": room.state_dict()})


async def _handle_next_track(room: Room) -> None:
    """Переключение на следующий трек из очереди. Текущий удаляется."""
    if not room.queue:
        return
    # удаляем файлы старого трека
    if room.track:
        remove_track_files(room.track)
    # достаём первый из очереди и делаем текущим
    next_item = room.queue.pop(0)
    room.track = next_item
    room.last_uploader = next_item.get("uploaded_by")
    room.position = 0.0
    room.play_started_at = time.time()
    room.playing = True  # очередь автоматически продолжается
    await broadcast(room.code, {"type": "track_change", "state": room.state_dict()})


async def _handle_queue_remove(room: Room, data: dict) -> None:
    qid = data.get("id")
    if not qid:
        return
    removed = None
    for i, item in enumerate(room.queue):
        if item.get("id") == qid:
            removed = room.queue.pop(i)
            break
    if removed:
        # удаляем файлы
        remove_track_files(removed)
        await broadcast(room.code, {"type": "queue_update", "state": room.state_dict()})


async def _handle_ping(websocket: WebSocket) -> None:
    await websocket.send_json({"type": "pong", "server_time": time.time()})


# =========================================================================
# WebSocket endpoint
# =========================================================================
@app.websocket("/api/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    await websocket.accept()
    if code not in rooms:
        await websocket.send_json({"type": "error", "message": "Комната не найдена"})
        await websocket.close()
        return

    room = rooms[code]
    ws_id = str(id(websocket))
    name: Optional[str] = None

    task = cleanup_tasks.pop(code, None)
    if task:
        task.cancel()

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except json.JSONDecodeError:
                continue

            mtype = data.get("type")
            if mtype == "join":
                name = await _handle_join(room, ws_id, websocket, data)
            elif mtype == "play":
                await _handle_play(room, data)
            elif mtype == "pause":
                await _handle_pause(room)
            elif mtype == "seek":
                await _handle_seek(room, data)
            elif mtype == "volume":
                await _handle_volume(room, name, data)
            elif mtype == "chat":
                await _handle_chat(room, name, data)
            elif mtype == "sync_request":
                await _handle_sync_request(room, websocket)
            elif mtype == "next_track":
                await _handle_next_track(room)
            elif mtype == "queue_remove":
                await _handle_queue_remove(room, data)
            elif mtype == "ping":
                await _handle_ping(websocket)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket error in room {code}: {e}")
    finally:
        room.connections.pop(ws_id, None)
        left_name = room.participants.pop(ws_id, None)
        if left_name:
            await broadcast(
                code,
                {
                    "type": "participants",
                    "participants": list(room.participants.values()),
                    "left": left_name,
                },
            )
        if code in rooms and len(rooms[code].connections) == 0:
            cleanup_tasks[code] = asyncio.create_task(cleanup_room_later(code))


# =========================================================================
# App setup
# =========================================================================
app.include_router(api_router)

# Auth: подключаем роутер /api/auth/* (register, login, me, refresh, logout)
def _get_db():
    return db


get_current_user_required, get_current_user_optional = make_auth_dependencies(_get_db)
app.include_router(build_auth_router(_get_db, get_current_user_required))

# CORS: с allow_credentials=True wildcard "*" недопустим — браузер блокирует.
# Перечисляем явные origin'ы (из CORS_ORIGINS, через запятую).
_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_origins or ["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    await setup_auth(db)
    logger.info("Auth: индексы созданы, admin засеялся")


@app.on_event("shutdown")
async def shutdown_event():
    mongo_client.close()
    for task in list(cleanup_tasks.values()):
        task.cancel()
