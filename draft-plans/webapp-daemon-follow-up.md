# yaac daemon — events, PTY, webapp

The daemon shipped in four phases: foundation, reads, writes, and
interactive + background loop. Today the CLI is a thin pass-through
over the daemon's HTTP API, the daemon owns all `src/lib/**` state
access, and the 5-s background loop runs inside the daemon.

This plan adds the pieces a richer client (the webapp in
`webapp-frontend.md`, or an ambitious TUI) needs: a push event
stream, a PTY bridge for embedded terminals, migration of
interactive CLI commands onto that bridge, static-asset serving for
the webapp bundle, and a browser-safe auth bootstrap.

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
- Serve the webapp bundle from the daemon itself so the browser UI
  is same-origin with the API.
- Offer a browser-safe auth handshake so cookies — not bearers in
  URLs — carry webapp credentials.

## Non-goals

- Remote access. Still 127.0.0.1 + auth only.
- Replacing HTTP. The existing read / write / interactive endpoints
  stay as they are; this plan adds WS and static routes alongside.
- Long-term message persistence. Event subscribers that miss a
  window reconnect and re-hydrate from the `snapshot` frame (see
  "Backfill on connect").
- Multi-user auth. One bootstrap code per machine / daemon lifetime;
  the cookie is a session, not a user.

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
                                        ┌─────────────┐
                                        │ static /    │
                                        │ /assets/*   │
                                        └─────────────┘
                                        ┌─────────────┐
                                        │ /auth/      │
                                        │  bootstrap  │
                                        └─────────────┘
```

HTTP, WebSocket, static serving, and auth bootstrap share one port.
Every request — HTTP or WS upgrade — passes through the auth
middleware, which accepts **either** a bearer header (CLI) **or** a
`yaac_session` cookie (webapp).

## Request gating

All non-public routes go through one gate:

- **Host-header check.** Reject if `Host` isn't `127.0.0.1:<port>`
  or `localhost:<port>`. Defeats DNS-rebinding.
- **CORS.** Only reflect same-origin in `Access-Control-Allow-Origin`.
  Preflights on cross-origin get 403. No wildcards, ever.
- **Auth.** Accept one of:
  - `Authorization: Bearer <secret>` matching `~/.yaac/.daemon-lock.json`.
  - `Cookie: yaac_session=<id>` matching an in-memory session map.
- **Public routes** (no auth): `GET /` (SPA HTML),
  `GET /assets/*` (SPA assets), `POST /auth/bootstrap`,
  `GET /health`.

The CSP header attaches to HTML responses only:
`default-src 'self'; connect-src 'self' ws://<host>; img-src 'self' data:`.

## Auth bootstrap

Browsers can't read the bearer out of the lock file, so we add a
one-time exchange:

1. Daemon startup generates a 256-bit `bootstrapCode`, logs it as
   part of the start banner (`open http://127.0.0.1:<port>/?bootstrap=<code>`).
2. Browser opens that URL. SPA reads `?bootstrap=`, `POST`s it to
   `/auth/bootstrap`.
3. Daemon validates:
   - Code matches the stored value.
   - Code hasn't been consumed.
   - Code was generated within the last 60 s.
4. On success: mint a `yaac_session` id, store it in-memory keyed
   to daemon lifetime, respond with
   `Set-Cookie: yaac_session=<id>; HttpOnly; SameSite=Strict;
   Path=/; Secure` (omit `Secure` in dev) plus a 204.
5. `bootstrapCode` is single-use; after consumption the daemon
   regenerates it for the next client. Multiple concurrent browser
   sessions are supported — each needs its own bootstrap
   round-trip.

The bootstrap code never appears in URLs after step 2: the SPA
calls `history.replaceState` to strip the query string. Daemon
never logs the code value — only `bootstrap ok` / `bootstrap fail`.

## Static asset serving

- `GET /` → `dist/frontend/index.html` with CSP headers.
- `GET /assets/*` → `dist/frontend/assets/*`, long-cache
  (content-hashed filenames from Vite).
- `GET /<path>` → fall back to `index.html` (SPA routing).
- In dev, `pnpm frontend:dev` runs Vite on its own port and proxies
  `/v1/*` + `/auth/*` to the daemon. Production is daemon-only.

Build wiring: `pnpm build` already runs `tsup` + copies
`dockerfiles` and `podman` into `dist/`. Extend it to also run
`vite build` and copy the result into `dist/frontend/`. The daemon
resolves the static dir relative to its own install location.

## Event stream

One WebSocket: `/v1/events`. Multiplexed JSON messages, each with a
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
| Webapp "new tab" | `WS /session/window?id=<id>` | `podman exec -it <container> sh -c 'tmux new-window -t yaac -a && tmux attach -t yaac'` |

Each PTY gets a `ptyId` returned in the WS accept frame. Reopening
`WS …?ptyId=<existing>` attaches to the existing PTY (tee stdout,
serialize stdin) — useful for a second tab over the same terminal
and for client reconnects. New windows opened via `window` show up
as tmux windows, so they're discoverable from a CLI `yaac session
attach` too — state stays consistent between webapp and CLI.

### Interactive CLI commands on the PTY bridge

After the bridge is available, the CLI stops doing `podman exec -it`
directly. The existing `attach-info` / `shell-info` HTTP endpoints
stay as a convenience for scripts, but the CLI wrappers now open
the WS and pipe the local TTY:

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
- Auth/token sharing with the webapp would be rolled-from-scratch
  anyway.
- `node-pty` + `podman exec -it` is ~40 LOC against an API we
  already depend on.

## Open external editor

The webapp can't launch a process on the host, so "open worktree in
editor" becomes a daemon endpoint:

- `POST /v1/open-editor` with body `{sessionId}`.
- Daemon resolves the worktree path, spawns the configured command
  (`code`, `cursor`, custom template), and returns 204 on success.
- Command template lives in the daemon's prefs store; default is
  `code <path>`. Validates that the binary is on PATH and that the
  template substitutes `<path>` exactly once before spawning.
- Spawn is fire-and-forget; stderr is captured to the daemon log
  under the session id for debugging.

## Test strategy

Per `CLAUDE.md`:

- **Unit**:
  - Event merger in isolation with a fake Podman event stream, fake
    fs events, and a fake poll tick. Assert exactly one fan-out per
    logical transition regardless of which source observed it first.
  - PTY handler parsing of control messages.
  - `/auth/bootstrap`: valid code → cookie; reused code → 401;
    expired code → 401; mismatched code → 401.
  - Host-header middleware: happy path + rebinding refusal.
- **E2E** (`test/e2e/daemon-ws.test.ts`, `daemon-webapp.test.ts`):
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
  - Bootstrap: fetch `/?bootstrap=<valid>`, exchange for cookie,
    use cookie on a subsequent `/v1/sessions/list`. Reuse-code
    attempt 401s.
  - `GET /` returns the SPA HTML with CSP headers, `GET /assets/*`
    serves hashed assets.
- **Image management**: still no new container images.

## Delivery

1. `/events` WS server, bearer+cookie auth, `snapshot` backfill on
   connect. Wire the already-running podman + fs sources into the
   fan-out.
2. PTY bridge: `WS /session/attach`, `WS /session/shell`,
   `WS /session/window`. Reconnect with `?ptyId=` works.
3. Switch `yaac session attach` and `yaac session shell` to the WS
   bridge. Drop the `attach-info` / `shell-info` HTTP endpoints or
   keep them behind a `--raw` flag, whichever is cheaper.
4. `WS /session/stream` + port `yaac session stream` onto it.
5. `WS /auth/update` + port `yaac auth update` onto it. Tool-login
   shell-outs (`claude login`, `codex login`) now run inside the
   daemon.
6. Static serving + `/auth/bootstrap` + Host-header + CORS
   middleware + CSP headers. `pnpm build` wires the frontend
   bundle into `dist/frontend/`.
7. `POST /v1/open-editor` + prefs storage for the editor template.
8. Webapp work (tracked in `webapp-frontend.md`) can proceed.

Each phase lands behind its own PR with unit + e2e tests.

## Open questions

1. **Access control for `/auth/update`.** Interactive OAuth flows
   produce real tokens in memory on the daemon side. Scope this to
   authenticated clients only (same as everything else), or add a
   per-request confirmation in the UI?
2. **PTY reconnect window.** How long does the daemon hold a
   detached PTY alive waiting for a reconnect vs. tearing it down?
   Probably keep indefinitely for `attach` / `window` (they're
   cheap — tmux is the actual long-lived thing), tear down
   immediately for `shell`.
3. **Backpressure on `/events`.** A slow subscriber shouldn't
   balloon memory. Drop and close, or buffer with a cap? Probably
   close with a `{type:"overrun"}` frame; the client reconnects
   and re-snapshots.
4. **Bootstrap code rotation.** Single-use per bootstrap means the
   daemon mints a new one after every successful exchange. If the
   user never opens the browser, the code sits in the daemon log
   indefinitely. Roll it on a 5-minute timer if unused? Probably
   yes — easy to add.
5. **HttpOnly vs. JS-readable cookie.** HttpOnly means the JS can't
   detect auth loss without a round-trip. Acceptable (401 handling
   does the detection), but confirm no flow needs client-side auth
   visibility.
