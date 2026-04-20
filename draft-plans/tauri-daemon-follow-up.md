# yaac daemon — follow-up: events, PTY, Tauri

Builds on `tauri-daemon.md`. Assumes that plan has shipped: the CLI
is a thin pass-through over the daemon's HTTP API, the daemon owns
all `src/lib/**` state access, and the 5-s background loop already
runs inside the daemon.

This plan adds the pieces a richer client (the Tauri frontend in
`tauri-frontend.md`, or an ambitious TUI) needs: a push event
stream, a PTY bridge for embedded terminals, and the migration of
interactive CLI commands onto that bridge.

## Goals

- Push change events to clients so UIs don't poll `/session/list`
  and `/prewarm` on a timer.
- Serve per-session PTYs so clients can embed terminals without
  re-implementing the `podman exec -it … tmux attach` dance.
- Let a second window over the same PTY tee the output (multiple
  clients on one terminal).
- Move the interactive CLI commands (`session attach`, `session
  shell`, `session stream`, `auth update`) onto the PTY bridge, so
  the CLI stops shelling out to `podman exec -it` directly. After
  this lands, the daemon is the only thing that spawns container
  execs.

## Non-goals

- Remote access. Still 127.0.0.1 + bearer auth only.
- Replacing HTTP. The read / write / interactive endpoints from
  `tauri-daemon.md` stay as they are; this plan adds WS alongside.
- Long-term message persistence. Event subscribers that miss a
  window reconnect and re-hydrate from the `snapshot` frame (see
  "Backfill on connect").

## Architecture delta

```
        before                              after
   ┌─────────────┐                      ┌─────────────┐
   │ hono HTTP   │                      │ hono HTTP   │
   └─────────────┘                      └─────────────┘
                                        ┌─────────────┐
   (background loop fires                │ WS server  │
    side effects, not                    │  /events    │
    observable to clients)               │  /session/… │
                                        │  /auth/…    │
                                        └─────────────┘
```

HTTP and WebSocket share the port. Bearer auth on every WS upgrade
too, via subprotocol header or `?token=`.

## Event stream

One WebSocket: `/events`. Multiplexed JSON messages, each with a
`type`:

- `session.created` — container first observed; payload matches
  `GET /session/:id`.
- `session.status` — transitions between `running` / `waiting` /
  `prewarm`.
- `session.prompt` — first user message appeared (or changed, e.g.
  after `claude resume`; matches the plan in
  `link-claude-session-log-after-resume.md`).
- `session.blocked-hosts` — new host blocked by the proxy.
- `session.exited` — tmux died / container removed. Payload carries
  the `AttachOutcome` enum (`detached` / `closed_blank` /
  `closed_prompted`) from `finalize-attached-session.ts` when
  available.
- `prewarm.state` — create / ready / claimed / failed, keyed by
  project.
- `project.added`, `project.removed`, `project.config-changed`.
- `credentials.changed` — keyed by service (`github` / `claude` /
  `codex`).

### Sources of events

Three producers, merged before fan-out (the first two already run
inside the daemon for its own reconciliation work; this plan
exposes them):

1. **Podman event stream.** `podman events --format=json` filtered
   by `yaac.data-dir=<dir>`; translate `create` / `start` / `die` /
   `remove` into `session.*` events.
2. **Filesystem watchers.** `fs.watch` on:
   - `~/.yaac/projects/<slug>/claude/.yaac-transcripts/` — drives
     `session.prompt` and `session.status`.
   - `~/.yaac/projects/<slug>/codex/.yaac-transcripts/` — same.
   - `~/.yaac/projects/<slug>/blocked-hosts/` — drives
     `session.blocked-hosts`.
   - `~/.yaac/.prewarm-sessions.json` — drives `prewarm.state`.
   - `~/.yaac/.credentials/` — drives `credentials.changed`.
   - `~/.yaac/projects/` — drives `project.added` / `project.removed`.
   Watchers debounce, then re-derive the affected slice from the
   source of truth rather than interpreting raw fs events.
3. **5-s safety-net poll.** Same cadence as today, already running.
   Reconciles anything the other two sources missed (podman `events`
   can drop under load; `fs.watch` differs across platforms).

Every subscriber gets the full stream. Filtering is the client's
responsibility; the volume is low (a few events per minute in a busy
session) so server-side filtering isn't worth the complexity.

### Backfill on connect

On connect, the server sends a synthetic `snapshot` event with the
current list of sessions, projects, and prewarm state so the client
doesn't need separate HTTP round-trips to hydrate. Makes reconnects
after a daemon restart idempotent.

## PTY bridge

Each terminal tab in a client is one PTY on the daemon side.
Exposed as WebSocket endpoints whose path mirrors the CLI command:

| Client | WS path | Spawns |
|---|---|---|
| `session attach <id>` | `WS /session/attach?id=<id>` | `podman exec -it <container> tmux attach -t yaac` |
| `session shell <id>` | `WS /session/shell?id=<id>` | `podman exec -it <container> zsh` |
| GUI "new tab" | `WS /session/window?id=<id>` | `podman exec -it <container> sh -c 'tmux new-window -t yaac -a && tmux attach -t yaac'` |

Each PTY gets a `ptyId` returned in the WS accept frame. Reopening
`WS …?ptyId=<existing>` attaches to the existing PTY (tee stdout,
serialize stdin) — useful for a second window over the same terminal
and for client reconnects. New windows opened via `window` show up
as tmux windows, so they're discoverable from a CLI `yaac session
attach` too — state stays consistent between GUI and CLI.

### Interactive CLI commands on the PTY bridge

After the bridge is available, the CLI stops doing `podman exec -it`
directly. The HTTP endpoints from `tauri-daemon.md` that returned
`attach-info` / `shell-info` stay as a convenience for scripts, but
the CLI wrappers now open the WS and pipe the local TTY:

| CLI | Implementation |
|---|---|
| `yaac session attach <id>` | `WS /session/attach?id=…`, pipe local TTY |
| `yaac session shell <id>` | `WS /session/shell?id=…`, pipe local TTY |
| `yaac session stream [project]` | `WS /session/stream?project=&tool=`, pipe local TTY |
| `yaac auth update` | `WS /auth/update`, pipe local TTY |

`WS /session/stream` multiplexes PTYs: the daemon picks the next
waiting session (or creates one), opens a PTY, streams it; on detach
it picks the next; on "no more" it closes. The CLI side is a pure
pump.

`WS /auth/update` runs the interactive flow on the daemon, including
the shell-outs to `claude login` / `codex login`. Simple prompts
travel as control messages; tool-login PTYs travel as binary frames.
After this lands, the daemon is the only process that invokes those
login CLIs, so credential bundles never transit the CLI process.

### Wire protocol

Binary WS frames carry raw PTY bytes in both directions (no base64
overhead). Text frames carry control messages:

- `{type:"resize", cols, rows}` — forwarded to `node-pty.resize()`.
- `{type:"signal", name:"SIGINT"|"SIGTERM"}` — forwarded to the PTY
  process group (rare; `Ctrl-C` normally goes through stdin).
- `{type:"ping"}` / `{type:"pong"}` — liveness.

Frames are disambiguated by WS frame kind: binary = data, text =
control. Simple and zero-overhead.

### Close semantics

- Client closes the socket → PTY detaches but keeps running. For
  `attach` / `window` this is "Ctrl-B D" style detach; tmux keeps
  the window open and the container alive. For `shell` it kills the
  zsh (detaching an unbound shell is meaningless).
- PTY process exits → server closes the socket with a payload
  describing the exit.
- Container dies → server closes all PTY sockets for that session
  and emits a `session.exited` event on `/events`.
- Daemon restart → all sockets close; on reconnect, the client
  re-opens with the same mode. Scrollback survives because tmux runs
  inside the container, which outlives the daemon.

### Why not ttyd

We considered running ttyd in every session container and iframing
it in the UI. Rejected because:

- ttyd isn't in the default image; installing it pushes two more
  binaries (ttyd + its libwebsockets) into every container.
- ttyd owns the terminal. The desired first-tab behavior is "attach
  an existing tmux session", not "spawn a new login shell". Getting
  ttyd to `tmux attach` is possible but awkward.
- Auth/token sharing with the Tauri client would be rolled-from-
  scratch anyway.
- `node-pty` + `podman exec -it` is ~40 LOC against an API we
  already depend on.

## Tauri frontend

With events + PTY in place, the Tauri shell (see `tauri-frontend.md`)
becomes a viable client:

- It spawns the daemon as a sidecar and reads the lock file for
  port + secret.
- It calls the HTTP API for one-shot reads and writes.
- It subscribes to `/events` for live updates instead of polling.
- It embeds xterm.js tabs against the PTY bridge.

CORS stays denied for browser origins. The webview uses Tauri's
IPC (for HTTP) and permission-gated WebSocket APIs, so no browser
origin is presented to the daemon.

## Test strategy

Per `CLAUDE.md`:

- **Unit**:
  - Event merger in isolation with a fake Podman event stream, fake
    fs events, and a fake poll tick. Assert exactly one fan-out per
    logical transition regardless of which source observed it first.
  - PTY handler parsing of control messages.
- **E2E** (`test/e2e/daemon-ws.test.ts`):
  - Connect to `/events`, observe `snapshot` on connect, then
    `session.created` + `session.status` when a session is created
    via the CLI.
  - `DELETE /project/:slug` tears down live sessions and emits
    `session.exited` + `project.removed`.
  - `POST /session/create` then attach a PTY WS, write `echo hi`,
    assert the bytes come back through the WS.
  - Two concurrent PTY WS clients on the same ptyId both receive
    the same output.
  - `WS /session/stream` transitions between sessions without the
    client re-opening.
  - `WS /auth/update` runs an end-to-end API-key flow and persists
    via the existing credentials endpoints.
- **Image management**: still no new container images.

## Delivery

1. `/events` WS server, bearer auth, `snapshot` backfill on connect.
   Wire the already-running podman + fs sources into the fan-out.
2. PTY bridge: `WS /session/attach`, `WS /session/shell`,
   `WS /session/window`. Reconnect with `?ptyId=` works.
3. Switch `yaac session attach` and `yaac session shell` to the WS
   bridge. Drop the `attach-info` / `shell-info` HTTP endpoints or
   keep them behind a `--raw` flag, whichever is cheaper.
4. `WS /session/stream` + port `yaac session stream` onto it.
5. `WS /auth/update` + port `yaac auth update` onto it. Tool-login
   shell-outs (`claude login`, `codex login`) now run inside the
   daemon.
6. Tauri frontend work (tracked in `tauri-frontend.md`) can proceed.

Each phase lands behind its own PR with unit + e2e tests.

## Open questions

1. **Access control for `/auth/update`.** Interactive OAuth flows
   produce real tokens in memory on the daemon side. Scope this to
   the handshake-secret holder only (same as everything else), or
   add a per-request confirmation?
2. **PTY reconnect window.** How long does the daemon hold a
   detached PTY alive waiting for a reconnect vs. tearing it down?
   Probably keep indefinitely for `attach` / `window` (they're
   cheap — tmux is the actual long-lived thing), tear down
   immediately for `shell`.
3. **Backpressure on `/events`.** A slow subscriber shouldn't
   balloon memory. Drop and close, or buffer with a cap? Probably
   close with a `{type:"overrun"}` frame; the client reconnects
   and re-snapshots.
