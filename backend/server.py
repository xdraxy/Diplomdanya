"""
SyncPlay — синхронное прослушивание музыки в комнатах.
Бэкенд на FastAPI с нативными WebSocket-соединениями.
"""
import asyncio
import json
import logging
import os
import random
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from motor.motor_asyncio import AsyncIOMotorClient
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 МБ
ROOM_CLEANUP_DELAY = 300  # 5 минут
CHAT_HISTORY_MAX = 200

# MongoDB
mongo_url = os.environ["MONGO_URL"]
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ["DB_NAME"]]

# Логирование
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("syncplay")

app = FastAPI()
api_router = APIRouter(prefix="/api")


class Room:
    """In-memory состояние комнаты."""

    def __init__(self, code: str):
        self.code: str = code
        # track = {file_path, url, title, artist, duration, uploaded_by, filename, cover_url}
        self.track: Optional[dict] = None
        self.position: float = 0.0  # позиция при паузе ИЛИ позиция в момент play_started_at
        self.play_started_at: Optional[float] = None
        self.playing: bool = False
        self.volume: float = 0.7
        # ws_id -> websocket / name
        self.connections: Dict[str, WebSocket] = {}
        self.participants: Dict[str, str] = {}
        self.uploader: Dict[str, str] = {}  # ws_id -> name, used for "host" marker (последний загрузивший)
        self.last_uploader: Optional[str] = None
        self.chat_history: List[dict] = []
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
        }


# Глобальные состояния
rooms: Dict[str, Room] = {}
cleanup_tasks: Dict[str, asyncio.Task] = {}


def generate_room_code() -> str:
    while True:
        code = "".join(random.choices(string.digits, k=6))
        if code not in rooms:
            return code


def safe_str(value) -> str:
    if value is None:
        return ""
    try:
        return str(value).strip()
    except Exception:
        return ""


def extract_metadata(file_path: Path, fallback_title: str) -> dict:
    """Извлечь ID3-теги и обложку."""
    title = fallback_title
    artist = "Неизвестный исполнитель"
    duration = 0.0
    cover_url = None

    try:
        audio = MP3(str(file_path))
        duration = float(audio.info.length or 0)
        tags = audio.tags
        if tags:
            if "TIT2" in tags:
                t = safe_str(tags["TIT2"].text[0]) if tags["TIT2"].text else ""
                if t:
                    title = t
            if "TPE1" in tags:
                a = safe_str(tags["TPE1"].text[0]) if tags["TPE1"].text else ""
                if a:
                    artist = a
    except Exception as e:
        logger.warning(f"MP3 metadata read failed: {e}")

    try:
        id3 = ID3(str(file_path))
        apic_frames = id3.getall("APIC")
        if apic_frames:
            apic = apic_frames[0]
            mime = apic.mime or "image/jpeg"
            ext = "jpg"
            if "png" in mime:
                ext = "png"
            elif "jpeg" in mime or "jpg" in mime:
                ext = "jpg"
            cover_path = file_path.with_suffix(f".cover.{ext}")
            with open(cover_path, "wb") as f:
                f.write(apic.data)
            cover_url = f"/api/files/{cover_path.name}"
    except ID3NoHeaderError:
        pass
    except Exception as e:
        logger.warning(f"Cover extraction failed: {e}")

    return {
        "title": title,
        "artist": artist,
        "duration": duration,
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
            except Exception:
                pass
            logger.info(f"Room {code} cleaned up after inactivity")
    except asyncio.CancelledError:
        pass


# ----------------------- REST endpoints -----------------------


@api_router.get("/")
async def root():
    return {"app": "syncplay", "ok": True}


@api_router.post("/rooms")
async def create_room():
    code = generate_room_code()
    rooms[code] = Room(code)
    try:
        await db.rooms.insert_one(
            {
                "code": code,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
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
):
    if code not in rooms:
        raise HTTPException(status_code=404, detail="Комната не найдена")

    filename = file.filename or "track.mp3"
    if not filename.lower().endswith(".mp3"):
        raise HTTPException(status_code=400, detail="Принимаются только MP3 файлы")

    # Чтение с проверкой размера
    chunks = []
    total = 0
    while True:
        chunk = await file.read(1024 * 64)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413, detail="Файл слишком большой (макс 20 МБ)"
            )
        chunks.append(chunk)

    file_id = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
    file_path = UPLOAD_DIR / f"{code}_{file_id}.mp3"
    with open(file_path, "wb") as f:
        for c in chunks:
            f.write(c)

    room = rooms[code]
    # Удаляем старые файлы
    if room.track:
        remove_track_files(room.track)

    fallback_title = filename.rsplit(".", 1)[0]
    meta = extract_metadata(file_path, fallback_title)

    cover_path = None
    if meta["cover_url"]:
        cover_path = str(
            UPLOAD_DIR / Path(meta["cover_url"]).name
        )  # /api/files/<name>

    track = {
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

    room.track = track
    room.last_uploader = name
    room.position = 0.0
    room.play_started_at = time.time()
    room.playing = True

    await broadcast(
        code,
        {
            "type": "track_change",
            "state": room.state_dict(),
        },
    )
    return {"ok": True, "track": room.state_dict()["track"]}


@api_router.get("/files/{filename}")
async def serve_file(filename: str):
    # Запрещаем path traversal
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
    return FileResponse(str(file_path), media_type=media)


# ----------------------- WebSocket -----------------------


@app.websocket("/api/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    await websocket.accept()
    if code not in rooms:
        await websocket.send_json(
            {"type": "error", "message": "Комната не найдена"}
        )
        await websocket.close()
        return

    room = rooms[code]
    ws_id = str(id(websocket))
    name: Optional[str] = None

    # Если был запланирован cleanup — отменяем
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
                    code,
                    {
                        "type": "participants",
                        "participants": list(room.participants.values()),
                        "joined": name,
                    },
                    exclude=ws_id,
                )

            elif mtype == "play":
                if room.track is None:
                    continue
                if not room.playing:
                    room.position = float(
                        data.get("position", room.current_position())
                    )
                    room.play_started_at = time.time()
                    room.playing = True
                await broadcast(
                    code,
                    {"type": "state", "state": room.state_dict()},
                )

            elif mtype == "pause":
                if room.track is None:
                    continue
                if room.playing:
                    room.position = room.current_position()
                    room.playing = False
                    room.play_started_at = None
                await broadcast(
                    code,
                    {"type": "state", "state": room.state_dict()},
                )

            elif mtype == "seek":
                if room.track is None:
                    continue
                pos = float(data.get("position", 0.0))
                duration = room.track.get("duration") or 0
                if duration and pos > duration:
                    pos = duration
                if pos < 0:
                    pos = 0
                room.position = pos
                if room.playing:
                    room.play_started_at = time.time()
                await broadcast(
                    code,
                    {"type": "state", "state": room.state_dict()},
                )

            elif mtype == "volume":
                vol = float(data.get("volume", 0.7))
                vol = max(0.0, min(1.0, vol))
                room.volume = vol
                await broadcast(
                    code,
                    {
                        "type": "volume",
                        "volume": room.volume,
                        "by": name or "Гость",
                    },
                )

            elif mtype == "chat":
                text = safe_str(data.get("text", ""))[:500]
                if not text:
                    continue
                msg = {
                    "type": "chat",
                    "name": name or "Гость",
                    "text": text,
                    "ts": time.time(),
                }
                room.chat_history.append(msg)
                if len(room.chat_history) > CHAT_HISTORY_MAX:
                    room.chat_history = room.chat_history[-CHAT_HISTORY_MAX:]
                await broadcast(code, msg)

            elif mtype == "sync_request":
                await websocket.send_json(
                    {"type": "sync", "state": room.state_dict()}
                )

            elif mtype == "ping":
                await websocket.send_json(
                    {"type": "pong", "server_time": time.time()}
                )

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


# ----------------------- App setup -----------------------

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_event():
    mongo_client.close()
    for task in list(cleanup_tasks.values()):
        task.cancel()
