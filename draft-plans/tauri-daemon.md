# yaac daemon

A long-running Node process that wraps the existing `src/lib/**` layer
behind a local HTTP + WebSocket API. It's the thing the Tauri frontend
(see `tauri-frontend.md`) talks to, but it stands on its own — any
client (a CLI, a TUI, a second frontend) can use it.

## Goals

- Expose every read and write yaac performs today through a stable,
  versioned localhost API.
- Emit live change events so UIs don't have to poll the filesystem
  and `podman ps`.
- Provide per-session PTY streams so UIs can embed a terminal without
  re-implementing the `podman exec -it … tmux attach` dance.
- Reuse `src/lib/**` unchanged. No forked logic.
- Coexist with the CLI: starting or stopping the daemon must never
  disturb a running `yaac session …` invocation.

## Non-goals

- Remote access. The daemon binds `127.0.0.1` only; anything past
  that is outside the threat model.
- Multi-user / multi-tenant. One daemon per host user.
- Auth beyond a per-start bearer secret (same pattern the proxy
  sidecar uses with `PROXY_AUTH_SECRET`).
- Replacing the CLI. The CLI stays the automation-friendly surface.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ yaac daemon (Node, one process)                                  │
│                                                                  │
│   HTTP server (hono)          WebSocket server                   │
│     │                           │ /events      (change fan-out)  │
│     │                           │ /sessions/:id/ptys/:ptyId      │
│     │                           │              (PTY bridge)      │
│     ▼                           ▼                                │
│   handler layer ─── bearer auth ─── request logging              │
│     │                                                            │
│     ▼                                                            │
│   src/lib/** (session, container, project, prewarm, ...)        │
│     │                         │                                  │
│     ▼                         ▼                                  │
│   dockerode              fs (~/.yaac/...)                        │
└──────────────────────────────────────────────────────────────────┘
```

Single process, single port. HTTP and WebSocket share the port.

## Entry point and lifecycle

New CLI subcommand (`src/commands/daemon.ts`):

```
yaac daemon [--port <n>] [--socket <path>]
```

- Default: bind `127.0.0.1:<ephemeral>`, print one machine-readable
  line on stdout:
  `yaac-daemon: port=<n> secret=<hex>` then keep stderr for logs.
- `--socket` variant binds a unix domain socket instead of a TCP port
  (cleaner for Tauri sidecar spawn on macOS/Linux). Bearer auth still
  required on the socket — uds permissions alone aren't enough once
  a malicious process on the same user account is in scope.
- Stdout line is the handshake. The Tauri shell reads it and uses the
  values for all subsequent requests. If the line doesn't appear
  within a few seconds, the shell treats the daemon as failed to
  start.
- SIGTERM: refuse new HTTP requests, drain open WS, then exit.
  Running containers are untouched; the CLI continues to work.
- Crash recovery: on restart the daemon re-reads state from Podman
  labels and the filesystem. No in-memory state needs persistence.

Register the command alongside the existing commands in
`src/index.ts`. Unlike session and auth commands it should *not* run
the `preAction` credential-check hook — the daemon is how a user
resolves missing credentials (via a proxied `auth update` endpoint),
so requiring credentials at startup would be a chicken/egg.

## State ownership

The daemon owns nothing that isn't already on disk or in Podman.
Every endpoint resolves state from the authoritative sources each
call, same as the CLI:

| Concern | Source |
|---|---|
| Sessions | `podman.listContainers({ filters: { label: ['yaac.data-dir=<dir>'] } })` — same as `session-list.ts` |
| Projects | `~/.yaac/projects/*/project.json` — same as `project-list.ts` |
| Prewarm | `~/.yaac/.prewarm-sessions.json` via `src/lib/prewarm.ts` |
| Credentials | `~/.yaac/.credentials/{github,claude,codex}.json` via `src/lib/project/credentials.ts` and `tool-auth.ts` |
| Project config | `yaac-config.json` in repo or `config-override/` via `resolveProjectConfig` |
| Session status / prompt | JSONL transcripts, read through `src/lib/session/status.ts` |
| Blocked hosts | `~/.yaac/projects/<slug>/blocked-hosts/<id>.json` via `readBlockedHosts` |

Because state is external, (a) the daemon can be killed at any time
without losing work, (b) the CLI works identically when the daemon
is running or not, (c) multiple daemons would technically work but
are not supported — the first successful bind wins.

## HTTP API surface

Versioned under `/v1`. Content type `application/json`. Bearer auth
on every route via `Authorization: Bearer <secret>`.

### Read endpoints (GET, side-effect free)

| Path | Response | Wraps |
|---|---|---|
| `/v1/health` | `{ok:true, version}` | — |
| `/v1/projects` | `[{slug, remoteUrl, addedAt, sessionCount}]` | `projectList()` |
| `/v1/projects/:slug` | `{meta, config, resolvedAllowedHosts}` | `resolveProjectConfig` + meta |
| `/v1/projects/:slug/config` | raw `yaac-config.json` + source (`repo` / `override`) | `loadProjectConfig` |
| `/v1/sessions` | `[{id, project, tool, status, prompt, createdAt, forwardedPorts, containerName}]` | same shape as `sessionList` |
| `/v1/sessions/deleted` | `[{sessionId, project, tool, created}]` | `sessionList({deleted:true})` |
| `/v1/sessions/:id` | session detail incl. labels and blocked-hosts count | combines above |
| `/v1/sessions/:id/blocked-hosts` | `string[]` | `readBlockedHosts` |
| `/v1/sessions/:id/prompt` | `{prompt:string}` | `getSessionFirstMessage` |
| `/v1/prewarm` | `{[slug]: PrewarmEntry}` | `readPrewarmSessions` |
| `/v1/credentials` | masked listing | `authList` equivalent |
| `/v1/tool/default` | `{tool}` | `getDefaultTool` |

### Write endpoints

| Method + path | Body | Wraps |
|---|---|---|
| `POST /v1/projects` | `{remoteUrl}` | `projectAdd` |
| `DELETE /v1/projects/:slug` | — | new: calls `sessionDelete` for each live session then `fs.rm(-rf)` of `projectDir(slug)` |
| `PUT /v1/projects/:slug/config` | raw JSON body | writes `config-override/yaac-config.json` |
| `DELETE /v1/projects/:slug/config-override` | — | removes override |
| `POST /v1/sessions` | `{project, tool?, addDir?[], addDirRw?[]}` | `sessionCreate` |
| `DELETE /v1/sessions/:id` | — | `sessionDelete` |
| `PUT /v1/credentials/github` | `{tokens: GithubTokenEntry[]}` | `saveCredentials` |
| `POST /v1/credentials/github` | `{pattern, token}` | `addToken` |
| `DELETE /v1/credentials/github/:pattern` | — | `removeToken` |
| `PUT /v1/credentials/:tool` | `{kind:'api-key', apiKey}` or `{kind:'oauth', bundle}` | `persistToolLogin` |
| `POST /v1/credentials/:tool/login` | — → returns `{ptyId}` | `runToolLogin` wired through PTY bridge (see below) |
| `DELETE /v1/credentials/:service` | — | `authClear` equivalent |
| `PUT /v1/tool/default` | `{tool}` | `setDefaultTool` |

### Error shape

Uniform:

```json
{ "error": { "code": "NOT_FOUND", "message": "project foo not found" } }
```

Codes mirror the CLI's exit behaviors:
- `NOT_FOUND` → the CLI's "No such session/project" paths.
- `VALIDATION` → input schema rejections.
- `CONFLICT` → e.g. creating a project that exists (`project-add` dup check).
- `PODMAN_UNAVAILABLE` → the CLI's "Failed to connect to Podman" branch.
- `AUTH_REQUIRED` → missing GitHub / tool credentials.
- `INTERNAL` → everything else.

## Event stream

One WebSocket, `/v1/events`. Bearer auth via subprotocol header or
`?token=`. Multiplexed messages, each a single JSON object with a
`type`:

- `session.created` — container first observed; payload includes the
  same shape as `GET /v1/sessions/:id`.
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

Three producers, merged before fan-out:

1. **Podman event stream.** Spawn `podman events --format=json`
   once per daemon start, filter by our `yaac.data-dir=<dir>` label,
   and translate `create` / `start` / `die` / `remove` into
   `session.*` events. This is the primary source for session
   lifecycle.
2. **Filesystem watchers.** `fs.watch` on:
   - `~/.yaac/projects/<slug>/claude/.yaac-transcripts/` — drives
     `session.prompt` and `session.status` (waiting ↔ running).
   - `~/.yaac/projects/<slug>/codex/.yaac-transcripts/` — same.
   - `~/.yaac/projects/<slug>/blocked-hosts/` — drives
     `session.blocked-hosts`.
   - `~/.yaac/.prewarm-sessions.json` — drives `prewarm.state`.
   - `~/.yaac/.credentials/` — drives `credentials.changed`.
   - `~/.yaac/projects/` directory entries — drives `project.added`
     / `project.removed`.
   Watchers debounce and then re-derive the affected slice from the
   source of truth rather than trying to interpret raw fs events.
3. **5-s safety-net poll.** Same cadence as `session-monitor.ts`.
   Reconciles any event sources that missed a change (podman
   `events` can drop under load; `fs.watch` behavior differs across
   platforms). The same loop also runs `clearFailedPrewarmSessions`
   and — when enabled — `ensurePrewarmSessions`, subsuming
   `yaac session monitor`'s responsibilities. Driving this from the
   daemon means the CLI's monitor can delegate prewarm to the
   daemon when one is running (see "Prewarm coordination" below).

Every subscriber gets the full stream. Filtering is the client's
responsibility; the volume is low (a few events per minute in a busy
session) so server-side filtering isn't worth the complexity.

### Backfill on connect

On connect, the server sends a synthetic `snapshot` event with the
current list of sessions and prewarm state so the client doesn't
need a separate `GET /sessions` round-trip to hydrate. This also
makes reconnects after a daemon restart idempotent.

## PTY bridge

Each terminal tab in a client is one PTY. Exposed as
`WS /v1/sessions/:id/ptys/:ptyId`:

- If `:ptyId` matches an existing PTY owned by this daemon, the
  socket attaches to it (same output stream, multiple clients
  allowed — tee stdout, serialize stdin). Useful for taking a second
  window over the same terminal.
- If `:ptyId` is new, the mode is derived from `?mode=`:

| mode | spawns | equivalent CLI path |
|---|---|---|
| `attach` (default) | `podman exec -it <container> tmux attach -t yaac` | `yaac session attach` (`session-attach.ts:25`) |
| `window` | `podman exec -it <container> sh -c 'tmux new-window -t yaac -a && tmux attach -t yaac'` | user hits `Ctrl-B C` after attach |
| `shell` | `podman exec -it <container> zsh` | `yaac session shell` (`session-shell.ts:17`) |

Extra tabs opened via `window` show up as additional tmux windows,
so they're discoverable from a CLI `yaac session attach` too — state
stays consistent between GUI and CLI.

### Wire protocol

Binary WS frames carry raw PTY bytes in both directions (no base64
overhead). JSON frames on the same socket carry control messages:

- `{type:"resize", cols, rows}` — forwarded to `node-pty.resize()`.
- `{type:"signal", name:"SIGINT"|"SIGTERM"}` — forwarded to the PTY
  process group (rare; mostly `Ctrl-C` should go through stdin).
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
  and emits a `session.exited` event.
- Daemon restart → all sockets close; on reconnect, the client
  re-opens with `?mode=attach` to the same session and tmux happily
  reattaches. Scrollback survives because tmux runs inside the
  container, which outlives the daemon.

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

## Auth

- Bearer secret generated via `crypto.randomBytes(32).toString('hex')`
  at daemon start. Printed on the stdout handshake line; never
  logged, never persisted.
- Every HTTP request and WS upgrade requires the secret. Missing or
  wrong secret → 401 before any handler runs.
- Because the daemon is 127.0.0.1-only, the secret defends against
  other processes on the same host; it is **not** a defense against
  a compromised user account (which already owns the filesystem and
  the Podman socket).
- Rotate per start — losing the secret is equivalent to restarting
  the daemon, which takes under a second.

## Prewarm coordination

The CLI's `yaac session monitor` runs `ensurePrewarmSessions` on a
loop. So does the daemon. If both run simultaneously they'd race to
create prewarm containers.

Resolution: a tiny lock file at
`~/.yaac/.daemon.lock` containing `{pid, port, startedAt}`. The
daemon writes it on start (checks it's stale or absent first) and
unlinks on graceful shutdown. The CLI monitor checks the file; if a
live daemon owns the lock, the monitor prints a one-liner and skips
its own prewarm loop while still polling for display. Stale detection
is "process doesn't exist or started more than N seconds ago and
handshake port doesn't answer".

## Security and trust

- 127.0.0.1 only. No TCP listener on any other interface. `--socket`
  is preferred when the client is local.
- Bearer auth on everything, including WS.
- CORS explicitly denied for browser origins — browser `fetch` is
  not allowed to talk to the daemon. The Tauri webview sends
  requests via Rust IPC (for HTTP) and through Tauri's permission-
  gated WebSocket APIs, so no HTTP origin is involved.
- The daemon's dependencies and native modules (`node-pty`) increase
  the binary surface vs. the CLI-only baseline; pin exact versions
  per `CLAUDE.md`.
- Log scrubbing: request logs include paths and status codes but
  never request/response bodies — token values in `PUT /credentials`
  must never be printed.

## Test strategy

Per `CLAUDE.md`:

- **Unit**: every daemon handler and helper gets a test under
  `test/unit/daemon/`. Handlers mostly delegate to `src/lib/**`, so
  most tests verify input parsing, error-mapping, and serialization.
  Heavy coverage for the underlying logic already exists.
- **Event fan-out**: unit test the event merger in isolation with a
  fake Podman event stream, fake fs events, and a fake poll tick.
  Assert exactly one fan-out per logical transition regardless of
  which source observed it first.
- **E2E**: new e2e suite under `test/e2e/daemon.test.ts`:
  - Daemon starts, prints handshake line, responds to `/v1/health`.
  - Create a session via the CLI while the daemon is running; the
    daemon emits `session.created` then `session.status` on the WS.
  - Delete the session via the CLI; emits `session.exited`.
  - `POST /v1/sessions` then attach a PTY WS, write `echo hi`,
    assert the bytes come back through the WS.
  - `DELETE /v1/projects/:slug` tears down live sessions and the
    project directory.
  - Two concurrent PTY WS clients on the same ptyId both receive
    the same output.
- **Image management**: no new container images; the pre-built
  image rules in `test/global-setup.ts` are unaffected.

## Delivery

One phase, deliverable end-to-end before any frontend work starts:

1. `src/commands/daemon.ts` + `yaac daemon` subcommand + handshake.
2. HTTP server (hono) with all read endpoints and the health route.
3. Event stream with the three sources merged and the `snapshot`
   backfill on connect.
4. Write endpoints wrapping the existing CLI commands.
5. PTY bridge with `attach` / `window` / `shell` modes.
6. Prewarm coordination lock file + CLI monitor awareness.
7. `credentials/login` PTY bridge for the interactive tool-login
   flows.

Each step lands behind its own PR with unit + e2e tests. Once 1–5
are in, a separate client (CLI script, curl, a tiny TUI) can
exercise the full surface; the frontend plan can then proceed
against a stable backend.

## Open questions

1. **TCP port vs. unix socket default.** `--socket` is cleaner on
   POSIX but Tauri's sidecar IPC has better defaults for stdio /
   TCP. Pick TCP for v1, add `--socket` as opt-in.
2. **Multi-daemon handling.** The lock file treats "daemon already
   running" as an error. Should a second `yaac daemon` instead
   discover the running one and exit 0 with its port? That would
   make GUI "start daemon" idempotent.
3. **Access control for `credentials/login`.** Interactive OAuth
   flows produce real tokens in memory briefly. Scope this to the
   handshake-secret holder only (same as everything else), or add a
   per-request confirmation?
4. **API versioning policy.** Start at `/v1`; bump on breaking
   schema changes. Worth documenting a deprecation window (e.g.
   `/v1` and `/v2` coexist for one minor yaac release).
