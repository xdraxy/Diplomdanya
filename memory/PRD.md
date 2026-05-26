# SyncPlay — PRD

## Original problem statement
Russian-language web app for synchronized multimedia listening: users join a 6-digit room, upload MP3 (≤20 MB), and play it synchronously across devices. Any participant can pause, change volume (broadcast to all), seek, or switch the track. Real-time sync via FastAPI native WebSocket; MongoDB for room metadata; local `uploads/` folder for files. Must operate in Russia without VPN — no Google Fonts, no CDN dependencies, system fonts only, dark theme.

## Architecture

### Backend (`/app/backend/server.py`)
- FastAPI + native WebSocket (no Socket.IO).
- MongoDB via Motor (`rooms` collection records creation timestamp; live room state is held in memory).
- In-memory dict `rooms: Dict[str, Room]` — `Room` holds: track metadata, position, play_started_at, playing flag, volume, participants {ws_id→name}, ws connections, chat history (last 200), last_uploader.
- File uploads stored in `/app/backend/uploads/` with naming `{code}_{rand}.mp3` and `_cover.{ext}` for embedded artwork.
- ID3 metadata extracted via `mutagen` (title, artist, duration, cover art).
- Cleanup: when last participant leaves, an `asyncio.Task` is scheduled to delete the room and its files after 5 min if still empty.

### Frontend (`/app/frontend/src/`)
- React (CRA + craco) with shadcn/ui components.
- Tailwind dark theme — cyan/blue accents on `#09090B` base.
- System-font stack only (no Google Fonts).
- Routes: `/` (Login) and `/room/:code` (Room).
- WebSocket abstraction in `hooks/useRoomSocket.js` (auto-reconnect, StrictMode-guarded).
- Sync: each client treats the most recent `state` message as ground truth — at receive time it snapshots `serverPos` + `receivedAt`; periodic (200 ms) drift check seeks audio if |local − target| > 0.35 s.

## Tasks done
- 2026-02-26 — MVP scaffolding complete (backend + frontend).
- 2026-02-26 — REST: create room, get room state, upload MP3 with progress, serve static files.
- 2026-02-26 — WebSocket message protocol: join / play / pause / seek / volume / chat / sync_request / ping; broadcasts to all participants.
- 2026-02-26 — Frontend: Login (create/join tabs, Russian validation), Room (player UI, chat, participants tabs, volume/seek sliders, upload with progress bar, ID3 cover display).
- 2026-02-26 — Test pass: backend 100% (14/14 pytest), frontend ~90% (StrictMode hardening applied).

## User personas
1. **Host** — creates a room, uploads an MP3, shares the 6-digit code with friends.
2. **Guest** — joins via code, listens in sync, optionally takes over and uploads a new track or sends chat messages.

## Core requirements (static)
- Russian-only UI.
- 6-digit numeric room codes, auto-generated.
- MP3 uploads up to 20 MB.
- Real-time sync with <100 ms drift target.
- All controls (play/pause/volume/seek/track-change) propagate to every participant.
- Auto-cleanup of idle rooms + files after 5 min.
- Adaptive layout (mobile + desktop).
- No external CDNs; system fonts; works in Russia without VPN.

## What's implemented (as of 2026-02-26)
- POST /api/rooms — create room
- GET /api/rooms/{code} — full room state
- POST /api/rooms/{code}/upload — MP3 upload (multipart, ≤20 MB) + ID3 + cover extraction
- GET /api/files/{filename} — serve audio/cover
- WS /api/ws/{code} — full message protocol
- Login screen with name validation
- Room screen: player, chat, participants, copy code, leave room, connection indicator
- Toasters for joins/leaves/volume changes/errors

## Prioritized backlog
- **P1**: queue of multiple tracks; reaction emojis in chat; mobile bottom-sheet layout polish.
- **P2**: persistent room ownership (host can mute others), playback history, optional room password, room name customization.
- **P2**: WebSocket exponential backoff on reconnect; replace in-memory rooms with Redis for multi-instance scaling.
- **P2**: server-side track normalization (loudness / re-encode) for huge files.

## Next tasks
- Optional: persistent rooms across backend restart (Redis or Mongo full state).
- Optional: queue UI (drag-reorder, autoplay next).
- Optional: deployment guide for RuVDS/TimeWeb with systemd unit + Nginx config.
