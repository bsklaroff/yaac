# yaac daemon

A long-running Node process that wraps the existing `src/lib/**` layer
behind a local HTTP API. The `yaac` CLI is the only client in this
plan: every `yaac <command>` invocation routes through the daemon.
The Tauri frontend and the WebSocket surface it needs (events, PTY
bridge) are deferred to `tauri-daemon-follow-up.md`.

## Goals

- Expose every read and write yaac performs today through a stable,
  localhost HTTP API.
- Make the CLI a pass-through: each `yaac <command>` call resolves to
  one (or a few) HTTP requests against the corresponding daemon
  routes. No `src/lib/**` state reads or writes happen in the CLI
  process.
- Reuse `src/lib/**` unchanged. No forked logic.
- Run the background work that `yaac session monitor` used to do
  (5-s reconciliation, `ensurePrewarmSessions`,
  `clearFailedPrewarmSessions`) inside the daemon.

## Non-goals

- Remote access. The daemon binds `127.0.0.1` only; anything past
  that is outside the threat model.
- Multi-user / multi-tenant. One daemon per host user.
- Auth beyond a per-start bearer secret (same pattern the proxy
  sidecar uses with `PROXY_AUTH_SECRET`).
- Standalone CLI mode. Once this plan lands, the CLI requires a
  running daemon; it does not read Podman or `~/.yaac/` directly.
- WebSockets, change-event streams, PTY-over-WS, and the Tauri
  frontend. All of that is in `tauri-daemon-follow-up.md`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ yaac daemon (Node, one process)                                  │
│                                                                  │
│   HTTP server (hono)                                             │
│     │                                                            │
│     ▼                                                            │
│   handler layer ─── bearer auth ─── request logging              │
│     │                                                            │
│     ▼                                                            │
│   src/lib/** (session, container, project, prewarm, ...)        │
│     │                         │                                  │
│     ▼                         ▼                                  │
│   dockerode              fs (~/.yaac/...)                        │
│                                                                  │
│   background loop: 5-s poll + `podman events` subscriber         │
│     drives prewarm + podman-state reconciliation (internal only) │
└──────────────────────────────────────────────────────────────────┘
          ▲
          │ HTTP
          │
┌─────────┴────────────┐
│ yaac CLI             │
│ (commander → fetch)  │
└──────────────────────┘
```

Single daemon process, single port. Everything over HTTP.

Interactive CLI commands (`session attach`, `session shell`,
`session stream`, `auth update`) still need a local PTY. For this
plan those commands run their PTY work in the CLI process — the
daemon resolves the container name and any other data they need,
and the CLI shells out to `podman exec -it` locally. The daemon's
own background loop picks up the resulting state changes like it
does for any other container transition.

## Entry point and lifecycle

New CLI subcommand (`src/commands/daemon.ts`):

```
yaac daemon [--port <n>]
```

- Default: bind `127.0.0.1:<ephemeral>`, write the handshake to
  `~/.yaac/.daemon.lock` (see "Daemon discovery"), and keep stderr
  for logs.
- Binds TCP only. Unix sockets are out of scope.
- Once started, the daemon runs until it's explicitly stopped
  (SIGTERM / SIGINT, machine shutdown). It does not auto-exit when
  idle; it outlives the CLI invocation that started it so subsequent
  invocations reuse the same process.
- SIGTERM: refuse new HTTP requests, finish in-flight handlers, then
  exit. Running containers are untouched.
- Crash recovery: on restart the daemon re-reads state from Podman
  labels and the filesystem. No in-memory state needs persistence.

Register the command alongside the existing commands in
`src/index.ts`. The `daemon` subcommand does *not* run the `preAction`
credential-check hook — the daemon is how a user resolves missing
credentials (via `POST /auth/*`), so requiring credentials at startup
would be a chicken/egg.

### CLI → daemon bootstrap

Every non-`daemon` CLI invocation resolves a daemon before doing
anything else:

1. Read `~/.yaac/.daemon.lock` to learn the port and secret of a
   running daemon.
2. If no lock exists or `GET /health` fails, the CLI spawns
   `yaac daemon` as a detached background process, waits for the
   lock to appear, and then continues.
3. Issue the HTTP request for the command. Translate `error.code`
   into the process exit status the CLI used to produce directly.

Users who run `yaac session list` on a fresh machine transparently
get a daemon. There is no user-visible "start the daemon first" step.

## State ownership

The daemon owns nothing that isn't already on disk or in Podman.
Every endpoint resolves state from the authoritative sources each
call:

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
without losing work, (b) a restart brings back full state without
coordination, (c) multiple daemons would technically work but are not
supported — the first successful bind wins.

## HTTP API surface

Routes mirror the CLI commands one-for-one. No version prefix — the
daemon ships in lockstep with the CLI in this repo, so the API and
the client that speaks it are always deployed together. Content type
`application/json`. Bearer auth on every route via
`Authorization: Bearer <secret>`.

### Read endpoints (GET, side-effect free)

| CLI | Method + path | Response | Wraps |
|---|---|---|---|
| — | `GET /health` | `{ok:true, version}` | — |
| `project list` | `GET /project/list` | `[{slug, remoteUrl, addedAt, sessionCount}]` | `projectList()` |
| `session list` | `GET /session/list?project=&deleted=` | `[{id, project, tool, status, prompt, createdAt, forwardedPorts, containerName}]` | `sessionList` |
| `tool get` | `GET /tool/get` | `{tool}` | `getDefaultTool` |
| `auth list` | `GET /auth/list` | masked listing | `authList` |

### Write endpoints (POST / DELETE)

| CLI | Method + path | Body | Wraps |
|---|---|---|---|
| `project add <url>` | `POST /project/add` | `{remoteUrl}` | `projectAdd` |
| `session create <project>` | `POST /session/create` | `{project, tool?, addDir?[], addDirRw?[]}` | `sessionCreate` |
| `session delete <id>` | `POST /session/delete` | `{sessionId}` | `sessionDelete` |
| `tool set <tool>` | `POST /tool/set` | `{tool}` | `setDefaultTool` |
| `auth clear` | `POST /auth/clear` | `{service}` | `authClear` |
| `auth update` (various) | see "Auth update routes" | — | pieces of `authUpdate` |

### Endpoints for interactive CLI commands

These exist so the CLI can do its local TTY work without reading the
filesystem or Podman itself. They're plain HTTP — no WS.

| CLI | Method + path | Response | Notes |
|---|---|---|---|
| `session attach <id>` | `GET /session/:id/attach-info` | `{containerName, tmuxSession}` | CLI then runs `podman exec -it` locally |
| `session shell <id>` | `GET /session/:id/shell-info` | `{containerName}` | CLI then runs `podman exec -it … zsh` locally |
| `session stream [project]` | `POST /session/stream/next` body `{project?, tool?}` | `{sessionId, containerName, tmuxSession}` or `{done:true}` | Daemon picks the next waiting session or creates one, returns the attach info. CLI attaches locally, loops. |
| `session monitor [project]` | `GET /session/list?…` + `GET /prewarm` on an interval | — | CLI polls at its configured cadence and renders locally. See "Monitor" below. |

### Auth update routes

`yaac auth update` is an interactive flow today: prompt for service
(GitHub / Claude / Codex), then either paste a token or drive an
OAuth handoff. For the CLI-only daemon, the CLI runs all prompts and
shell-outs locally and calls the daemon only to read current state
and to write results.

| CLI step | Method + path | Body / response | Wraps |
|---|---|---|---|
| Add a GitHub token | `POST /auth/github/tokens` | `{pattern, token}` | `addToken` |
| Remove a GitHub token | `DELETE /auth/github/tokens/:pattern` | — | `removeToken` |
| Replace all GitHub tokens | `PUT /auth/github/tokens` | `{tokens: GithubTokenEntry[]}` | `saveCredentials` |
| Store a tool API key | `PUT /auth/:tool` | `{kind:'api-key', apiKey}` | `persistToolLogin` |
| Import a tool OAuth bundle | `PUT /auth/:tool` | `{kind:'oauth', bundle}` | `persistToolLogin` |

OAuth flows that currently shell out to the tool's own login CLI
(`claude login`, `codex login`) keep running in the CLI process for
this plan — they write to `~/.claude/` or `~/.codex/`, and the CLI
then reads the resulting bundle and `PUT`s it via
`/auth/:tool`. Moving those login shell-outs into the daemon requires
the PTY bridge and is part of the follow-up.

### Monitor

`yaac session monitor` used to do two things: (1) render the session
list on a 5-s loop, (2) run `ensurePrewarmSessions` and
`clearFailedPrewarmSessions` on the same loop.

In the daemon world, (2) moves into the daemon's internal background
loop (runs whether anyone is watching or not, so prewarm stays warm
even with no client attached). (1) becomes a thin CLI poller: `GET
/session/list` + `GET /prewarm` on the user-configured interval,
render a table, sleep, repeat.

The `--no-prewarm` flag is dropped. Prewarm is a daemon-wide concern;
a flag on one CLI invocation shouldn't disable it.

### Endpoints with no direct CLI analogue

Not strictly needed for the CLI but cheap to ship alongside the rest
and used by the follow-up Tauri work:

| Method + path | Purpose |
|---|---|
| `GET /project/:slug` | Project detail incl. resolved config and allowed hosts |
| `GET /project/:slug/config` | Raw `yaac-config.json` + source (`repo` / `override`) |
| `PUT /project/:slug/config` | Writes `config-override/yaac-config.json` |
| `DELETE /project/:slug/config-override` | Removes override |
| `DELETE /project/:slug` | Tears down live sessions, then `fs.rm(-rf)` of `projectDir(slug)` |
| `GET /session/:id` | Session detail incl. labels and blocked-hosts count |
| `GET /session/:id/blocked-hosts` | `string[]` |
| `GET /session/:id/prompt` | `{prompt:string}` via `getSessionFirstMessage` |
| `GET /prewarm` | `{[slug]: PrewarmEntry}` via `readPrewarmSessions` |

### Error shape

Uniform:

```json
{ "error": { "code": "NOT_FOUND", "message": "project foo not found" } }
```

The CLI translates these into exit statuses that match the old
behavior:
- `NOT_FOUND` → the old "No such session/project" path, exit 1.
- `VALIDATION` → input schema rejection, exit 2.
- `CONFLICT` → e.g. duplicate `project add`, exit 1.
- `PODMAN_UNAVAILABLE` → the old "Failed to connect to Podman" branch.
- `AUTH_REQUIRED` → CLI invokes `auth update` flow inline and retries.
- `INTERNAL` → everything else, exit 1.

## CLI command mapping

| CLI | Implementation |
|---|---|
| `yaac daemon` | Starts the daemon (only command that doesn't talk to one) |
| `yaac project list` | `GET /project/list`, print table |
| `yaac project add <url>` | `POST /project/add` |
| `yaac session list [project]` | `GET /session/list?project=…`, print table |
| `yaac session create <project>` | `POST /session/create` |
| `yaac session delete <id>` | `POST /session/delete` |
| `yaac session attach <id>` | `GET /session/:id/attach-info` → local `podman exec -it` |
| `yaac session shell <id>` | `GET /session/:id/shell-info` → local `podman exec -it … zsh` |
| `yaac session stream [project]` | Loop: `POST /session/stream/next` → local attach → repeat |
| `yaac session monitor [project]` | Poll `GET /session/list` + `GET /prewarm`, render |
| `yaac tool get` / `tool set` | `GET /tool/get` / `POST /tool/set` |
| `yaac auth list` | `GET /auth/list`, print table |
| `yaac auth update` | Local prompts + local tool-login shell-outs, then `PUT /auth/…` |
| `yaac auth clear` | Local prompt, then `POST /auth/clear` |

## Background loop

Even without a client event stream, the daemon runs the same 5-s
poll + `podman events` subscription that `session-monitor.ts` runs
today, used exclusively for its own side effects:

- `ensurePrewarmSessions` / `clearFailedPrewarmSessions` keep the
  prewarm pool healthy.
- Session transitions observed in Podman events trigger the same
  filesystem writes `session-monitor.ts` would (prompt link, status
  files, etc., per `link-claude-session-log-after-resume.md`).

Nothing in this loop is observable to clients in this plan — its
output is state changes on disk and in Podman that a subsequent
`GET /session/list` will pick up. The loop is a prerequisite for the
follow-up event stream.

## Auth

- Bearer secret generated via `crypto.randomBytes(32).toString('hex')`
  at daemon start. Written to the lock file (`chmod 600`); never
  logged elsewhere.
- Every HTTP request requires the secret. Missing or wrong secret →
  401 before any handler runs.
- Because the daemon is 127.0.0.1-only, the secret defends against
  other processes on the same host; it is **not** a defense against
  a compromised user account (which already owns the filesystem and
  the Podman socket).
- Rotated per daemon start. If the CLI's cached secret becomes
  invalid (daemon restarted), the CLI re-reads the lock and retries.

## Daemon discovery

A single lock file at `~/.yaac/.daemon.lock` serves two purposes:

1. **Discovery.** The CLI reads it to find the daemon's port and
   bearer secret.
2. **Mutual exclusion.** A second `yaac daemon` checks the file; if a
   live daemon already owns the lock, it exits 0 after printing the
   existing handshake. This makes "start daemon" idempotent.

Format:

```json
{ "pid": 1234, "port": 51734, "secret": "…", "startedAt": 17… }
```

Write on start (after successful bind), unlink on graceful shutdown.
Stale detection is "process doesn't exist OR `/health` doesn't answer
within 500ms".

Because prewarm is owned entirely by the daemon now, there is no CLI
vs. daemon race. The `session monitor` CLI no longer runs a prewarm
loop of its own.

## Security and trust

- 127.0.0.1 only. No TCP listener on any other interface.
- Bearer auth on every route.
- CORS explicitly denied for browser origins — browser `fetch` is
  not allowed to talk to the daemon.
- The daemon's dependency surface vs. the CLI-only baseline is small
  in this plan (hono + its deps); pin exact versions per `CLAUDE.md`.
- Log scrubbing: request logs include paths and status codes but
  never request/response bodies — token values in `PUT /auth/*`
  must never be printed.

## Test strategy

Per `CLAUDE.md`:

- **Unit**: every daemon handler and helper gets a test under
  `test/unit/daemon/`. Handlers mostly delegate to `src/lib/**`, so
  most tests verify input parsing, error-mapping, and serialization.
  Heavy coverage for the underlying logic already exists.
- **E2E**: the existing CLI e2e suites must keep passing — since they
  invoke the CLI, they now implicitly exercise the daemon end-to-end.
  A new `test/e2e/daemon.test.ts` covers daemon-specific surface:
  - Daemon starts, writes the lock file, responds to `/health`.
  - A second `yaac daemon` invocation is idempotent (exits 0, reuses
    the lock).
  - CLI auto-starts a daemon when none is running.
  - Error mapping: `GET /session/list?project=missing` → 404 with
    `NOT_FOUND` → CLI exits 1 with the expected message.
  - Prewarm loop runs without any connected client (create a project,
    wait, expect a prewarmed container to exist).
- **Image management**: no new container images; the pre-built
  image rules in `test/global-setup.ts` are unaffected.

## Delivery

Lands in a single PR. There's no intermediate state where half the
CLI talks to the daemon and half still reads `src/lib/**` directly —
that intermediate state would double the surface to reason about (two
code paths per command, two sets of error modes) for no user-visible
benefit. All of the below goes together:

- `src/commands/daemon.ts` + `yaac daemon` subcommand + handshake +
  lock file.
- Shared CLI client in `src/lib/daemon-client.ts`: auto-start,
  reading the lock, bearer auth, error mapping.
- All HTTP routes listed above (read, write, interactive-command
  helpers, auth, no-CLI-analogue).
- Daemon background loop: `ensurePrewarmSessions` +
  `clearFailedPrewarmSessions` on a 5-s tick, plus the
  `podman events` subscription.
- Every CLI command ported to the daemon client. `session monitor`
  loses `--no-prewarm` and becomes a pure poller over
  `/session/list` + `/prewarm`. Interactive commands (`session
  attach`, `session shell`, `session stream`, `auth update`) use
  HTTP helpers and do their local TTY work in the CLI process.
- Unit tests for every handler and CLI client helper.
- New `test/e2e/daemon.test.ts` plus the existing CLI e2e suites
  passing end-to-end through the daemon.
