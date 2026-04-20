# yaac daemon — phase 4: interactive + background loop

Final phase. After this lands, the CLI is a pure daemon client: no
direct `src/lib/**` reads or writes in any command except
`yaac daemon` itself.

Depends on phases 1, 2, and 3.

## In scope

### Attach-info routes for interactive commands

| CLI | Method + path | Response |
|---|---|---|
| `session attach <id>` | `GET /session/:id/attach-info` | `{containerName, tmuxSession}` |
| `session shell <id>` | `GET /session/:id/shell-info` | `{containerName}` |
| `session stream [project]` | `POST /session/stream/next` body `{project?, tool?}` | `{sessionId, containerName, tmuxSession}` or `{done:true}` |

The CLI runs `podman exec -it <containerName> …` locally. PTY work
stays in the CLI process; the daemon just resolves container names
and (for `stream/next`) picks/creates the next waiting session.

### CLI commands ported

- `yaac session attach <id>`
- `yaac session shell <id>`
- `yaac session stream [project] [--tool …]`
- `yaac session monitor [project] [--interval …]` — **becomes a pure
  poller**. Drop `--no-prewarm` and `--prewarm-tool`. The daemon
  owns prewarm; a CLI flag can't turn it off.

### Daemon background loop

Runs inside the daemon from boot. On every 5-s tick *and* in
response to `podman events`:

- `ensurePrewarmSessions()`
- `clearFailedPrewarmSessions()`
- Reconcile session transitions (prompt link, status files) — the
  same side effects `session-monitor.ts` performs today.
- Stale-container cleanup that today lives at the bottom of
  `sessionList()` moves here.

The loop is unobservable to clients in this phase — its output is
state changes on disk and in Podman that a subsequent
`GET /session/list` or `GET /prewarm` picks up. It's a prerequisite
for the follow-up WebSocket event stream (see
`tauri-daemon-follow-up.md`).

Shutdown: stop the loop, let in-flight handlers complete, unlink
the lock, exit.

### Decommissions

- Remove the `preAction` hook from `src/index.ts`. Every command
  path now surfaces `AUTH_REQUIRED` via the daemon, which the
  client retries after running `auth update`.
- Remove `--no-prewarm` and `--prewarm-tool` from
  `yaac session monitor`.
- Delete any `src/lib/**` import from `src/commands/*.ts` other
  than types and renderer helpers. The CLI talks to the daemon,
  period.

## Out of scope

- WebSocket change-event streams, PTY-over-WS, Tauri frontend —
  covered by `tauri-daemon-follow-up.md`.

## Tests

- Unit tests for the three new route handlers and the background
  loop (inject a fake clock + fake `podman events` stream; assert
  prewarm calls happen on the tick).
- E2E additions:
  - Prewarm loop runs without any connected client (create a
    project with one live session, wait, expect a prewarmed
    container to exist).
  - Kill the daemon mid-stream → `session stream` exits cleanly
    with an `INTERNAL` error (not a hang).
  - `session attach` with a bogus id → `NOT_FOUND` → exit 1.
- All existing interactive-command e2e suites must keep passing.
- Monitor e2e: remove any `--no-prewarm` assertions.

## Delivery

Single PR.

## Done

After this phase the feature in `tauri-daemon.md` (the original
plan) is complete. The CLI is a thin HTTP client, and the next
work — WebSockets, a Tauri frontend, PTY bridging — can build on
top without further changes to the command layer.
