# OnDemand Chat MVP (Split Architecture)

Frontend and backend are separated from the first step:
- `frontend`: Next.js + TypeScript
- `backend`: Express + TypeScript + SQLite

## Run With Docker (Recommended)
Prerequisite:
- Docker Desktop (or Docker Engine) running

```bash
cd /Users/higamotoki/practice/digest-chat-split-mvp
make app_start_dev
```

- App (nginx): `http://localhost:8080`

Stop:
```bash
make app_stop_dev
```
`app_stop_dev` runs `docker compose down -v` and resets dev DB volume.

Logs:
```bash
make app_logs_dev
```

Hot reload:
- Frontend: Next.js HMR (save `frontend/src/**`)
- Backend: `tsx watch` restart (save `backend/src/**`)
- Realtime data: server-sent events (`/api/events`) for channel/thread/message/task updates

## Core Difference
- Add `:task` in a message to auto-create task.
- Created tasks appear in Task Dashboard (GitHub taskboard-like columns: Open/Doing/Done).
- Main area is tabbed:
- `Thread` tab is default.
- `Dashboard` tab is shown only when selected.
- On channel creation, default thread `main` is automatically created.
- Dashboard is thread-scoped (shows tasks for selected thread only).

## Directory
- `frontend/`: web UI
- `backend/`: API server and SQLite DB
- `nginx/`: reverse proxy config
- `TECH_REQUIREMENTS.md`: technical requirement summary
- `docker-compose.yml`: unified development environment
- `Makefile`: shortcut commands for Docker/local run

## Run Locally
Prerequisite:
- Node.js `v20+`
- npm `v10+`

### 1) Start backend
```bash
make local_install
make local_build
make local_backend
```

Backend runs at `http://localhost:4000`.

### 2) Start frontend
```bash
make local_frontend
```

Frontend runs at `http://localhost:3000`.

## Implemented MVP Features
- Signup/Login/Logout with server-side session
- Tab-scoped session handling via `sessionStorage`
- Channel creation/listing
- Thread creation/listing per channel
- Message post/list per thread
- Realtime sync by SSE (no polling)
- Unread badge feedback for non-open threads
- Auto move to created channel/thread
- Task dashboard from message flags:
- `:task` in message => task auto-created
- task creation feedback is posted as chat message by `TaskBot`
- status management: `open`, `doing`, `done`
- status update is shared in realtime to all connected clients
- drag & drop task cards across `Open / Doing / Done` columns
- done tasks remain visible for a retention period (default 14 days)
- Thread Activity includes both channel name and thread title for each unread item

## Notes
- SQLite file is created automatically at `backend/data.sqlite`.
- Docker mode stores SQLite at `/app/db/data.sqlite` in `backend_db` volume.
- Docker mode exposes only nginx (`localhost:8080`) and proxies:
- `/` -> frontend
- `/api/*` -> backend
- If you change `nginx/default.conf`, run `make app_restart_dev`.
