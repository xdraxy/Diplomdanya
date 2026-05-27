"""Iteration 5: Queue feature tests."""
import asyncio
import json
import pytest
import websockets

from test_syncplay import _make_dummy_mp3, _ws_url


@pytest.fixture
def room_with_track(api_client, base_url):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    files = {"file": ("first.mp3", _make_dummy_mp3(), "audio/mpeg")}
    r = api_client.post(
        f"{base_url}/api/rooms/{code}/upload",
        data={"name": "Owner"},
        files=files,
    )
    assert r.status_code == 200
    return code


class TestQueueUpload:
    def test_room_state_has_queue_field(self, api_client, base_url):
        code = api_client.post(f"{base_url}/api/rooms").json()["code"]
        st = api_client.get(f"{base_url}/api/rooms/{code}").json()
        assert "queue" in st
        assert isinstance(st["queue"], list)
        assert st["queue"] == []

    def test_upload_to_queue_appends_when_current_exists(self, api_client, base_url, room_with_track):
        code = room_with_track
        files = {"file": ("second.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{code}/upload",
            data={"name": "Queuer"},
            files=files,
            params={"to_queue": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("queued") is True
        assert body["track"]["id"]
        # state queue contains 1 item
        st = api_client.get(f"{base_url}/api/rooms/{code}").json()
        assert len(st["queue"]) == 1
        q0 = st["queue"][0]
        for k in ("id", "title", "artist", "duration", "added_by"):
            assert k in q0, f"missing {k} in queue item: {q0}"

    def test_upload_to_queue_without_current_replaces(self, api_client, base_url):
        # to_queue=true but no current track → should still REPLACE (i.e. set as current)
        code = api_client.post(f"{base_url}/api/rooms").json()["code"]
        files = {"file": ("only.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{code}/upload",
            data={"name": "X"},
            files=files,
            params={"to_queue": "true"},
        )
        assert r.status_code == 200
        body = r.json()
        # Since room.track was None, server falls through to replace path
        assert body.get("queued") is False
        st = api_client.get(f"{base_url}/api/rooms/{code}").json()
        assert st["track"] is not None
        assert st["queue"] == []

    def test_upload_without_to_queue_replaces_current(self, api_client, base_url, room_with_track):
        code = room_with_track
        files = {"file": ("replace.mp3", _make_dummy_mp3(), "audio/mpeg")}
        r = api_client.post(
            f"{base_url}/api/rooms/{code}/upload",
            data={"name": "Replacer"},
            files=files,
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("queued") is False
        st = api_client.get(f"{base_url}/api/rooms/{code}").json()
        # current track replaced (filename of new upload), queue unchanged (empty)
        assert st["track"]["filename"] == "replace.mp3"
        assert st["queue"] == []


@pytest.mark.asyncio
async def test_ws_next_track_advances_from_queue(base_url, api_client):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    # Upload current
    files = {"file": ("cur.mp3", _make_dummy_mp3(), "audio/mpeg")}
    api_client.post(f"{base_url}/api/rooms/{code}/upload", data={"name": "A"}, files=files)
    # Upload to queue
    files2 = {"file": ("next.mp3", _make_dummy_mp3(), "audio/mpeg")}
    rq = api_client.post(
        f"{base_url}/api/rooms/{code}/upload",
        data={"name": "B"},
        files=files2,
        params={"to_queue": "true"},
    )
    assert rq.status_code == 200
    queued_id = rq.json()["track"]["id"]

    async with websockets.connect(_ws_url(base_url, code)) as ws:
        await ws.send(json.dumps({"type": "join", "name": "Joiner"}))
        init = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert init["type"] == "init"
        assert len(init["state"]["queue"]) == 1

        await ws.send(json.dumps({"type": "next_track"}))
        # wait for track_change
        for _ in range(10):
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if m.get("type") == "track_change":
                break
        else:
            raise AssertionError("no track_change received")

        st = m["state"]
        assert st["playing"] is True
        # Note: state_dict.track strips the 'id' field (only queue items expose id).
        # Verify by track filename instead.
        assert st["track"] is not None
        assert st["track"]["filename"] == "next.mp3"
        assert st["queue"] == []


@pytest.mark.asyncio
async def test_ws_next_track_noop_on_empty_queue(base_url, api_client):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    files = {"file": ("cur.mp3", _make_dummy_mp3(), "audio/mpeg")}
    api_client.post(f"{base_url}/api/rooms/{code}/upload", data={"name": "A"}, files=files)
    async with websockets.connect(_ws_url(base_url, code)) as ws:
        await ws.send(json.dumps({"type": "join", "name": "X"}))
        await asyncio.wait_for(ws.recv(), timeout=5)  # init
        await ws.send(json.dumps({"type": "next_track"}))
        # no-op → no message; just timeout 1s
        try:
            m = await asyncio.wait_for(ws.recv(), timeout=1.2)
            # If it sent a track_change for nothing, that would be a bug
            assert m.get("type") != "track_change", f"unexpected track_change on empty queue: {m}"
        except asyncio.TimeoutError:
            pass  # expected


@pytest.mark.asyncio
async def test_ws_queue_remove(base_url, api_client):
    code = api_client.post(f"{base_url}/api/rooms").json()["code"]
    files = {"file": ("cur.mp3", _make_dummy_mp3(), "audio/mpeg")}
    api_client.post(f"{base_url}/api/rooms/{code}/upload", data={"name": "A"}, files=files)
    files2 = {"file": ("q.mp3", _make_dummy_mp3(), "audio/mpeg")}
    rq = api_client.post(
        f"{base_url}/api/rooms/{code}/upload",
        data={"name": "B"},
        files=files2,
        params={"to_queue": "true"},
    )
    qid = rq.json()["track"]["id"]
    async with websockets.connect(_ws_url(base_url, code)) as ws:
        await ws.send(json.dumps({"type": "join", "name": "X"}))
        await asyncio.wait_for(ws.recv(), timeout=5)  # init
        await ws.send(json.dumps({"type": "queue_remove", "id": qid}))
        for _ in range(10):
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if m.get("type") == "queue_update":
                break
        else:
            raise AssertionError("no queue_update")
        assert m["state"]["queue"] == []
    # REST also confirms
    st = api_client.get(f"{base_url}/api/rooms/{code}").json()
    assert st["queue"] == []
