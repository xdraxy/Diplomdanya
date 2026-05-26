"""Backend tests for SyncPlay app — REST + WebSocket."""
import asyncio
import io
import json
import os
import struct

import pytest
import requests
import websockets


def _ws_url(base_url: str, code: str) -> str:
    return base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/api/ws/{code}"


def _make_dummy_mp3(size_bytes: int = 2048) -> bytes:
    """Construct a minimal MP3 with ID3v2 header containing TIT2/TPE1 tags.
    Mutagen will parse the ID3 tags; the rest can be silence frames or zero
    bytes — extract_metadata is wrapped in try/except so it falls back."""
    # Build a small ID3v2.3 frame with TIT2 and TPE1.
    def text_frame(frame_id: bytes, text: str) -> bytes:
        # encoding byte 0x03 = UTF-8
        body = b"\x03" + text.encode("utf-8")
        return frame_id + struct.pack(">I", len(body)) + b"\x00\x00" + body

    frames = text_frame(b"TIT2", "Test Title") + text_frame(b"TPE1", "Test Artist")
    # sync-safe size
    sz = len(frames)
    syncsafe = bytes([(sz >> 21) & 0x7F, (sz >> 14) & 0x7F, (sz >> 7) & 0x7F, sz & 0x7F])
    id3_header = b"ID3" + b"\x03\x00" + b"\x00" + syncsafe
    id3 = id3_header + frames
    # An MPEG-1 Layer III frame header (44.1kHz, 128kbps, stereo): 0xFFFB9064
    mp3_frame = b"\xff\xfb\x90\x64" + b"\x00" * 414  # ~1 frame ≈ 418 bytes
    payload = id3 + (mp3_frame * 20)
    if len(payload) < size_bytes:
        payload += b"\x00" * (size_bytes - len(payload))
    return payload


# ============ REST tests ============

class TestRoot:
    def test_root_ok(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200
        assert r.json().get("ok") is True


class TestRoomsCRUD:
    def test_create_room_returns_6digit_code(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/rooms")
        assert r.status_code == 200
        data = r.json()
        assert "code" in data
        assert len(data["code"]) == 6
        assert data["code"].isdigit()

    def test_get_existing_room(self, api_client, base_url, created_room):
        r = api_client.get(f"{base_url}/api/rooms/{created_room}")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == created_room
        assert body["track"] is None
        assert body["playing"] is False
        assert body["volume"] == 0.7
        assert "server_time" in body
        assert isinstance(body["participants"], list)

    def test_get_nonexistent_room_404(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/rooms/000000")
        assert r.status_code == 404


class TestUpload:
    def test_upload_to_missing_room_404(self, api_client, base_url):
        files = {"file": ("track.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/000000/upload",
            data={"name": "Алексей"},
            files=files,
        )
        assert r.status_code == 404

    def test_upload_non_mp3_rejected(self, api_client, base_url, created_room):
        files = {"file": ("track.wav", b"RIFF....WAVE", "audio/wav")}
        r = api_client.post(
            f"{base_url}/api/rooms/{created_room}/upload",
            data={"name": "Алексей"},
            files=files,
        )
        assert r.status_code == 400

    def test_upload_too_big_returns_413(self, api_client, base_url, created_room):
        # > 20 MB
        big = b"\x00" * (20 * 1024 * 1024 + 1024)
        files = {"file": ("big.mp3", big, "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{created_room}/upload",
            data={"name": "Алексей"},
            files=files,
        )
        assert r.status_code == 413

    def test_upload_valid_mp3_and_metadata(self, api_client, base_url, created_room):
        files = {"file": ("song.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{created_room}/upload",
            data={"name": "Тестер"},
            files=files,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        tr = body["track"]
        # Title is either ID3 TIT2 or fallback to filename stem
        assert tr["title"] in ("Test Title", "song")
        assert isinstance(tr["artist"], str) and len(tr["artist"]) > 0
        assert tr["uploaded_by"] == "Тестер"
        assert tr["url"].startswith("/api/files/")
        assert "duration" in tr

        # GET — verify state persisted
        rs = api_client.get(f"{base_url}/api/rooms/{created_room}").json()
        assert rs["track"] is not None
        assert rs["track"]["filename"] == "song.mp3"
        assert rs["last_uploader"] == "Тестер"
        # Per spec (iteration 3): upload does NOT auto-play. Server fixes
        # position=0, playing=False, play_started_at=None. User must press Play.
        assert rs["playing"] is False
        assert rs["position"] == 0

        # Serve the file
        fr = api_client.get(f"{base_url}{tr['url']}")
        assert fr.status_code == 200
        assert "audio" in fr.headers.get("content-type", "")


class TestFileServe:
    def test_path_traversal_blocked(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/files/..%2Fetc%2Fpasswd")
        # Either 400 (caught) or 404 — must NOT be 200
        assert r.status_code in (400, 404)

    def test_missing_file_404(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/files/nonexistent_abc.mp3")
        assert r.status_code == 404


class TestRangeRequests:
    """Iteration 4: HTTP Range support is critical for <audio> seek."""

    @pytest.fixture
    def uploaded_url(self, api_client, base_url, created_room):
        files = {"file": ("range.mp3", _make_dummy_mp3(8192), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{created_room}/upload",
            data={"name": "Range"},
            files=files,
        )
        assert r.status_code == 200, r.text
        return r.json()["track"]["url"]

    def test_no_range_returns_200_with_accept_ranges(self, api_client, base_url, uploaded_url):
        r = api_client.get(f"{base_url}{uploaded_url}")
        assert r.status_code == 200
        assert r.headers.get("accept-ranges", "").lower() == "bytes"
        assert "audio" in r.headers.get("content-type", "")
        # Full file content returned
        assert len(r.content) > 0

    def test_range_bytes_0_99_returns_206(self, api_client, base_url, uploaded_url):
        r = api_client.get(
            f"{base_url}{uploaded_url}",
            headers={"Range": "bytes=0-99"},
        )
        assert r.status_code == 206, f"Expected 206 Partial Content, got {r.status_code}"
        assert r.headers.get("content-length") == "100"
        cr = r.headers.get("content-range", "")
        assert cr.startswith("bytes 0-99/"), f"bad Content-Range: {cr}"
        assert r.headers.get("accept-ranges", "").lower() == "bytes"
        assert len(r.content) == 100

    def test_range_bytes_200_499_returns_206_300_bytes(self, api_client, base_url, uploaded_url):
        r = api_client.get(
            f"{base_url}{uploaded_url}",
            headers={"Range": "bytes=200-499"},
        )
        assert r.status_code == 206
        assert r.headers.get("content-length") == "300"
        cr = r.headers.get("content-range", "")
        assert cr.startswith("bytes 200-499/")
        assert len(r.content) == 300

    def test_range_open_ended_uses_file_size_minus_1(self, api_client, base_url, uploaded_url):
        # First find file size
        head = api_client.get(f"{base_url}{uploaded_url}")
        total = len(head.content)
        # Request bytes=N- (no end)
        start = total - 50
        r = api_client.get(
            f"{base_url}{uploaded_url}",
            headers={"Range": f"bytes={start}-"},
        )
        assert r.status_code == 206
        assert r.headers.get("content-length") == "50"
        cr = r.headers.get("content-range", "")
        assert cr == f"bytes {start}-{total - 1}/{total}"
        assert len(r.content) == 50

    def test_malformed_range_returns_416(self, api_client, base_url, uploaded_url):
        head = api_client.get(f"{base_url}{uploaded_url}")
        total = len(head.content)
        # Range beyond EOF
        r = api_client.get(
            f"{base_url}{uploaded_url}",
            headers={"Range": f"bytes={total + 100}-{total + 200}"},
        )
        assert r.status_code == 416
        cr = r.headers.get("content-range", "")
        assert cr == f"bytes */{total}"

    def test_invalid_range_unit_returns_416(self, api_client, base_url, uploaded_url):
        r = api_client.get(
            f"{base_url}{uploaded_url}",
            headers={"Range": "items=0-10"},
        )
        assert r.status_code == 416


# ============ WebSocket tests ============

@pytest.mark.asyncio
async def test_ws_join_and_init(base_url, api_client):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    async with websockets.connect(_ws_url(base_url, code)) as ws:
        await ws.send(json.dumps({"type": "join", "name": "Алиса"}))
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert msg["type"] == "init"
        assert msg["you"] == "Алиса"
        assert msg["state"]["code"] == code
        assert msg["chat"] == []


@pytest.mark.asyncio
async def test_ws_missing_room_error(base_url):
    async with websockets.connect(_ws_url(base_url, "999999")) as ws:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert msg["type"] == "error"
        assert "не найдена" in msg["message"]


@pytest.mark.asyncio
async def test_ws_two_clients_sync_chat_volume(base_url, api_client):
    """A → play/pause/volume/chat must reach B."""
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]

    # Upload a track first so play/pause have an effect
    files = {"file": ("song.mp3", _make_dummy_mp3(), "audio/mpeg")}
    r = api_client.post(
        f"{base_url}/api/rooms/{code}/upload",
        data={"name": "Up"},
        files=files,
    )
    assert r.status_code == 200

    async with websockets.connect(_ws_url(base_url, code)) as a, \
            websockets.connect(_ws_url(base_url, code)) as b:
        await a.send(json.dumps({"type": "join", "name": "Алиса"}))
        await asyncio.wait_for(a.recv(), timeout=5)  # init for A
        await b.send(json.dumps({"type": "join", "name": "Боб"}))
        # B init
        b_init = json.loads(await asyncio.wait_for(b.recv(), timeout=5))
        assert b_init["type"] == "init"
        assert b_init["state"]["track"] is not None
        # A should get "participants" with joined=Боб
        async def wait_for_type(sock, t, timeout=5):
            end = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < end:
                m = json.loads(await asyncio.wait_for(sock.recv(), timeout=timeout))
                if m.get("type") == t:
                    return m
            raise AssertionError(f"no {t}")

        part = await wait_for_type(a, "participants")
        assert "Боб" in part["participants"]

        # A → pause; B should receive state
        await a.send(json.dumps({"type": "pause"}))
        m = await wait_for_type(b, "state")
        assert m["state"]["playing"] is False

        # A → volume; B should receive volume
        await a.send(json.dumps({"type": "volume", "volume": 0.42}))
        m = await wait_for_type(b, "volume")
        assert abs(m["volume"] - 0.42) < 0.001
        assert m["by"] == "Алиса"

        # A → seek to 5
        await a.send(json.dumps({"type": "seek", "position": 5.0}))
        m = await wait_for_type(b, "state")
        assert m["state"]["position"] == 5.0

        # A → chat
        await a.send(json.dumps({"type": "chat", "text": "Привет"}))
        m = await wait_for_type(b, "chat")
        assert m["text"] == "Привет"
        assert m["name"] == "Алиса"

        # A → ping
        await a.send(json.dumps({"type": "ping"}))
        m = await wait_for_type(a, "pong")
        assert "server_time" in m


@pytest.mark.asyncio
async def test_ws_upload_does_not_autoplay_and_play_propagates(base_url, api_client):
    """Iteration 3 spec: upload must NOT auto-play. Pressing play flips state
    for all connected clients."""
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]

    async with websockets.connect(_ws_url(base_url, code)) as a, \
            websockets.connect(_ws_url(base_url, code)) as b:
        await a.send(json.dumps({"type": "join", "name": "Алиса"}))
        await asyncio.wait_for(a.recv(), timeout=5)  # init
        await b.send(json.dumps({"type": "join", "name": "Боб"}))
        await asyncio.wait_for(b.recv(), timeout=5)  # init
        # drain participants notifications
        async def drain(sock, t=0.3):
            try:
                while True:
                    await asyncio.wait_for(sock.recv(), timeout=t)
            except asyncio.TimeoutError:
                pass
        await drain(a)
        await drain(b)

        # Upload — both clients should receive track_change with playing=False
        files = {"file": ("song.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{code}/upload",
            data={"name": "Алиса"}, files=files,
        )
        assert r.status_code == 200

        async def wait_type(sock, t):
            for _ in range(10):
                m = json.loads(await asyncio.wait_for(sock.recv(), timeout=5))
                if m.get("type") == t:
                    return m
            raise AssertionError(f"no {t}")

        tc_a = await wait_type(a, "track_change")
        tc_b = await wait_type(b, "track_change")
        assert tc_a["state"]["playing"] is False
        assert tc_a["state"]["position"] == 0
        assert tc_b["state"]["playing"] is False
        assert tc_b["state"]["track"] is not None

        # REST GET also confirms state
        rs = api_client.get(f"{base_url}/api/rooms/{code}").json()
        assert rs["playing"] is False
        assert rs["position"] == 0

        # A presses play — B should receive state with playing=True
        await a.send(json.dumps({"type": "play", "position": 0}))
        st_b = await wait_type(b, "state")
        assert st_b["state"]["playing"] is True

        # A pauses — both flip to playing=False; position preserved >=0
        await asyncio.sleep(0.3)
        await a.send(json.dumps({"type": "pause"}))
        st_b = await wait_type(b, "state")
        assert st_b["state"]["playing"] is False
        assert st_b["state"]["position"] >= 0

        # A seeks to 7 while paused — position must equal 7
        await a.send(json.dumps({"type": "seek", "position": 7.0}))
        st_b = await wait_type(b, "state")
        assert abs(st_b["state"]["position"] - 7.0) < 0.01


@pytest.mark.asyncio
async def test_ws_new_client_receives_chat_history(base_url, api_client):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    async with websockets.connect(_ws_url(base_url, code)) as a:
        await a.send(json.dumps({"type": "join", "name": "Анна"}))
        await asyncio.wait_for(a.recv(), timeout=5)  # init
        await a.send(json.dumps({"type": "chat", "text": "history1"}))
        # consume own broadcast
        await asyncio.wait_for(a.recv(), timeout=5)

        # New client joins and should receive history in init
        async with websockets.connect(_ws_url(base_url, code)) as b:
            await b.send(json.dumps({"type": "join", "name": "Боб"}))
            init = json.loads(await asyncio.wait_for(b.recv(), timeout=5))
            assert init["type"] == "init"
            assert any(m.get("text") == "history1" for m in init["chat"])
