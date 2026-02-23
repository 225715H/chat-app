# Technical Requirements (MVP)

## 1. Architecture
- Split architecture:
- `frontend`: Next.js (App Router, TypeScript)
- `backend`: Express API (TypeScript)
- `nginx`: reverse proxy for single entrypoint
- Development environment is unified by Docker Compose.

## 2. Product Differentiation
- Lightweight backlog creation from chat messages.
- When message includes `:task`, backend auto-registers a task.
- Tasks are visible in a shared backlog-like dashboard.

## 3. Core Functional Scope
- Auth: signup/login/logout with server-side session table.
- Chat: channels, threads, messages.
- Task extraction from messages:
- Trigger: message contains `:task`.
- Store task with linkage to channel/thread/message/user.
- Task dashboard:
- list tasks
- task status: `open`, `doing`, `done`
- status update is shared by SSE (`task_updated`)
- board interaction: drag-and-drop between status columns
- done task retention: keep done tasks visible for recent period (default 14 days)
- Realtime sync:
- Server-Sent Events (`/events`) for `channel_created`, `thread_created`, `message_created`, `task_created`, `task_updated`.
- Feedback:
- Unread update badge for non-open threads.
- Main view tabs:
- `Thread` (default visible)
- `Dashboard` (hidden by default, shown when tab selected)
- Channel bootstrap:
- On channel creation, backend auto-creates default thread `main`.

## 4. Data Store
- SQLite file in backend (`backend/data.sqlite` or volume path).
- Schema tables:
- `users`, `sessions`, `channels`, `threads`, `messages`, `thread_reads`, `tasks`.

## 5. API Contract (minimum)
- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`
- `GET /events`
- `GET /channels`
- `POST /channels`
- `GET /channels/:channelId/threads`
- `POST /channels/:channelId/threads`
- `GET /threads/:threadId/messages`
- `POST /threads/:threadId/messages`
- `POST /threads/:threadId/read`
- `GET /tasks?status=open|done&channelId=`
- `PATCH /tasks/:taskId` (`status: open|doing|done`)

## 6. Session Design
- Session ID is opaque random token.
- Session state is stored server-side (`sessions`).
- Required fields:
- `expires_at` for TTL control.
- `revoked_at` for logout invalidation.
- Validation on each authenticated request:
- session exists, not revoked, not expired.
- Sliding expiration update on authenticated access.
- Client stores session id in tab-scoped `sessionStorage` and sends `x-session-id`.

## 7. Non-functional Constraints (MVP)
- Local-first development.
- CORS restricted to frontend origin.
- Docker dev stop command (`make app_stop_dev`) resets DB volume for clean re-run.
