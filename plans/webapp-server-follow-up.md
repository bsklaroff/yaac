# yaac server — events, PTY, webapp

The server shipped in four phases: foundation, reads, writes, and
interactive + background loop. Today the CLI is a thin pass-through
over the server's HTTP API, the server owns all `src/lib/**` state
access, and the 5-s background loop runs inside the server.

This plan added the pieces a richer client (the webapp in
`webapp-frontend.md`, or an ambitious TUI) needs. The webapp-facing
half has shipped — a push snapshot stream, a PTY bridge for embedded
terminals, static-asset serving for the webapp bundle, and a
browser-safe auth bootstrap. What remains is migrating the
interactive *CLI* commands onto that bridge (so the server becomes
the only thing that spawns container execs), an open-editor endpoint,
and a couple of polish items. See "Shipped" for the done pieces and
"Remaining work" for what's left.

The session runtime is Kubernetes: sessions run as single-pod Jobs,
and all container execs shell out to `kubectl exec` (there is no
podman in the session path — podman is only the image-build engine).

## Shipped

These landed across the webapp PRs and are described in their own
sections below for reference. They are done; this section is the
quick index.

- **Auth bootstrap** (`src/server/web-auth.ts`, `src/server/server.ts`).
  One-time, single-use, rotating bootstrap code exchanged for an
  HttpOnly `yaac_session` cookie. Deviations from the original
  sketch, all intentional:
  - **TTL is 24h, not 60s.** The code is single-use and 256-bit and
    is already retrievable from `yaac server logs` for the server's
    lifetime, so a short TTL adds little but creates a real "code
    expired before I opened the browser" papercut. It still rotates
    on every successful exchange.
  - **Added `GET /auth/bootstrap-code`** (authenticated): `yaac open`
    fetches a fresh code over the bearer-authed API and builds a
    ready-to-open URL, so nothing scrapes the server log.
  - **Multi-session persistence.** Minted sessions are capped FIFO
    (`MAX_SESSIONS`) and persisted across server restarts so a
    rebuild doesn't force every open browser to re-bootstrap.
- **Static asset serving + build wiring** (`src/server/static.ts`,
  `vite.config.ts`, `package.json`). `GET /` serves `index.html`
  with CSP; `GET /assets/*` serves hashed assets with a long cache.
  `pnpm build` runs `tsup && vite build` and emits the SPA into
  `dist/frontend/`; the server registers the static routes when that
  bundle is present. `pnpm frontend:dev` runs Vite and proxies the
  server API + `/events` + `/pty` over to the bound server port.
- **Request gating** (`src/server/web-auth.ts`, `src/server/auth.ts`).
  One auth gate accepts a bearer header (CLI) *or* a `yaac_session`
  cookie (webapp). Plus a Host-header check and a CORS guard, with
  two deliberate simplifications noted in "Request gating" below.

## Goals

The remaining (unshipped) goals:

- Move the interactive CLI commands (`session attach`, `session
  shell`, `session stream`, `auth update`) onto the PTY bridge, so
  the CLI stops shelling out to `kubectl exec -it` directly. After
  this lands, the server is the only thing that spawns container
  execs.
- Let the webapp open a session's worktree in a host editor (the
  browser can't spawn a host process).

Already met by the shipped work:

- Push change events to clients so UIs don't poll `/session/list`
  and `/prewarm` on a timer (delivered as a `snapshot` stream — see
  "Event stream").
- Serve per-session PTYs so clients can embed terminals without
  re-implementing the `kubectl exec -it … tmux attach` dance.
- Serve the webapp bundle from the server itself so the browser UI
  is same-origin with the API.
- Offer a browser-safe auth handshake so cookies — not bearers in
  URLs — carry webapp credentials.

## Non-goals

- Remote access. Still 127.0.0.1 + auth only.
- Replacing HTTP. The existing read / write / interactive endpoints
  stay as they are; WS and static routes sit alongside.
- Long-term message persistence. Subscribers that miss a window
  reconnect and re-hydrate from the `snapshot` frame.
- Multi-user auth. One bootstrap code per machine / server lifetime;
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
    observable to clients)               │  /pty/attach│
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
`yaac_session` cookie (webapp). The WS routes (`/events`,
`/pty/attach`) are registered on the node server in
`src/server/cli.ts`, not in `buildApp`, so `buildApp`'s return type
stays the plain Hono app the CLI's typed RPC client infers from.

## Request gating

Shipped. All non-public routes go through one gate:

- **Host-header check.** Reject if `Host`'s *hostname* isn't
  `127.0.0.1` or `localhost`. Defeats DNS-rebinding.
  - *Simplification vs. the original sketch:* only the hostname is
    checked, **not** the port. A port-forward (common when reaching
    the server from outside its container) legitimately remaps the
    external port, so the browser's `Host` port need not equal the
    server's bound port. The port comparison adds no real defense
    anyway — a rebind request must already target the server's real
    port to connect.
- **CORS.** Implemented as deny-all-browser-CORS: preflight
  (`OPTIONS`) gets `405`, and no `Access-Control-Allow-Origin` is
  ever emitted.
  - *Simplification vs. the original sketch:* the webapp is
    same-origin with the server, so it never needs CORS at all.
    Rather than reflect same-origin in ACAO, the server refuses
    cross-origin browser access outright. Same end effect, less code.
- **Auth.** Accept one of:
  - `Authorization: Bearer <secret>` matching `~/.yaac/.server-lock.json`.
  - `Cookie: yaac_session=<id>` matching the in-memory session map.
- **Public routes** (no auth): `GET /` (SPA HTML),
  `GET /assets/*` (SPA assets), `POST /auth/bootstrap`,
  `GET /health`.

The CSP header attaches to HTML responses only (`SPA_CSP` in
`src/server/static.ts`):
`default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;
base-uri 'self'; frame-ancestors 'none'`.

## Auth bootstrap

Shipped (`src/server/web-auth.ts`, `src/server/server.ts`,
`src/server/cli.ts`). Browsers can't read the bearer out of the lock
file, so a one-time exchange bridges them in:

1. Server startup generates a 256-bit `bootstrapCode` and logs it as
   part of the start banner
   (`open http://127.0.0.1:<port>/?bootstrap=<code>`).
2. Browser opens that URL. The SPA reads `?bootstrap=`, `POST`s it to
   `/auth/bootstrap`.
3. Server validates: code matches, code hasn't been consumed, and
   the code was generated within the TTL (**24h** — see "Shipped"
   for the rationale).
4. On success: mint a `yaac_session` id, store it in-memory keyed to
   server lifetime, respond with
   `Set-Cookie: yaac_session=<id>; HttpOnly; SameSite=Strict;
   Path=/` plus a 204. **`Secure` is omitted** — the server is http
   on loopback, and browsers reject `Secure` cookies over http.
5. `bootstrapCode` is single-use; a successful exchange rotates it so
   the consumed value can't be replayed. Multiple concurrent browser
   sessions are supported, each via its own round-trip; the minted
   set is FIFO-capped and persisted across restarts.

The SPA calls `history.replaceState` to strip the query string after
step 2. The server never logs the code value — only `bootstrap ok` /
`bootstrap fail`.

`yaac open` (`src/server/cli.ts`) skips the log entirely: it ensures
the server is up, fetches a fresh code over the bearer-authed
`GET /auth/bootstrap-code`, prints the authed URL (scriptable), and
launches a browser.

## Static asset serving

Shipped (`src/server/static.ts`, `vite.config.ts`).

- `GET /` → `dist/frontend/index.html` with CSP headers, no-cache.
- `GET /assets/*` → `dist/frontend/assets/*`, long-cache, immutable
  (content-hashed filenames from Vite). Asset paths are confined to
  `frontendDir/assets` so a crafted `..`-laden request can't escape
  the bundle.
- In dev, `pnpm frontend:dev` runs Vite on its own port and proxies
  the server API + `/events` + `/pty` to the bound server port.
  Production is server-only.

Build wiring: `pnpm build` runs `tsup && vite build`, copies
`dockerfiles` + `k8s` into `dist/`, and emits the SPA into
`dist/frontend/` (Vite `outDir`). The server resolves the static dir
relative to its own install location and registers the static routes
only when `dist/frontend/index.html` is present (absent in dev/test,
where Vite serves the app).

**Pending polish:** SPA deep-link fallback. There is no
`GET /<path>` → `index.html` catch-all today; unknown paths return
the server's JSON `404`. The webapp keeps its routing client-side, so
this only matters for hard-reloading a deep link or sharing one. Add
a fallback route that serves `index.html` for non-API, non-asset GETs
when the bundle is present.

## Event stream

Shipped, but as a **snapshot stream**, not the granular typed
taxonomy originally sketched.

One WebSocket: `/events` (`src/server/cli.ts`, `src/server/events.ts`).
The server emits a single message type:

- `snapshot` — the full server state the webapp hydrates from
  (`ServerSnapshot`: active sessions, stale sessions, projects, and
  provisioning rows). The same data the equivalent HTTP reads return,
  gathered in one shot.

On connect, the server sends a `snapshot` immediately so the client
needs zero follow-up HTTP round-trips to hydrate, and reconnects
after a server restart are idempotent. The `EventHub` fan-out
re-serializes the snapshot and **only broadcasts when it differs from
the last one sent**, so an idle server produces no traffic. The
frontend (`src/frontend/lib/useEvents.ts`) writes each `snapshot`
frame straight into its query cache.

### What drives a broadcast

Two triggers, both already inside the server:

1. **The 5-s background-loop tick** (`onTick` → `hub.publishSnapshot()`
   in `src/server/cli.ts`). The reconcile cadence doubles as the
   safety-net refresh.
2. **`onSessionListChanged`** — an explicit nudge fired the moment a
   session is created/restarted/renamed (`notifySessionListChanged`),
   so the sidebar and terminal update immediately instead of waiting
   for the next tick.

Because the hub diffs before broadcasting, both triggers are
idempotent: a change observed by either path produces exactly one
fan-out.

### Pending: granular event taxonomy

The original plan called for typed deltas (`session.created`,
`session.status`, `session.prompt`, `session.blocked-hosts`,
`session.exited`, `prewarm.state`, `project.added` / `removed` /
`config-changed`, `credentials.changed`) merged from three
producers. **None of that was built**, and the snapshot model has so
far made it unnecessary — the volume is a few changes per minute and
the whole snapshot is small. The granular taxonomy is deferred until
a concrete consumer needs deltas (e.g. an animation that must know
*which* host was just blocked, not just that the set changed). If/when
it's added it should layer *alongside* `snapshot`, not replace it, and
derive from the same source-of-truth re-reads — there is no
podman-event or `fs.watch` producer in the runtime (sessions are k8s
Jobs), so a delta producer would re-derive from the cluster + state
files the snapshot already reads.

## PTY bridge

Shipped (`src/server/cli.ts`, `src/server/pty-bridge.ts`).

Each terminal tab in a client is one PTY on the server side, exposed
as a **single** WebSocket endpoint with a `target` query param —
not the three separate paths originally sketched:

Every target attaches through a per-client grouped **view session**
(named `view-<hex>` by the server) pinned to a single tmux window,
with `destroy-unattached on` (the throwaway session dies on detach),
`status off` (no tmux status bar — the webapp tab strip is the only
window list; the CLI's direct attach keeps the bar), and `prefix
None` (no tmux key bindings in webapp panes — switching is webapp
shortcuts, and `C-b` passes through to the agent; mouse mode is
unaffected):

| `target` query | Pins the view session to | Spawns (under a PTY on the server) |
|---|---|---|
| `agent` (default) | the `yaac` session's lowest-index window (the agent CLI) | `kubectl exec -it job/<name> -- sh -c 'exec tmux new-session -t yaac -s view-<hex> \; set destroy-unattached on \; set status off \; set prefix None \; select-window -t view-<hex>:^'` |
| `window:@<id>` | any other window of the `yaac` session — an initCommands dev server or a scratch shell | `kubectl exec -it job/<name> -- sh -c 'exec tmux new-session -t yaac -s view-<hex> \; set … \; select-window -t @<id>'` |

Scratch shells are plain `yaac`-session windows (`shell`, `shell-2`,
…) — there are no separate shell tmux sessions. The webapp creates
them explicitly via `POST /session/:id/terminals` (which returns the
new window's target) and kills any non-agent window via
`POST /session/:id/terminals/close` (the server refuses the agent
window). initCommands windows marked `hidePane` skip
`remain-on-exit`, so the window — and with it the webapp pane —
disappears when the command finishes.

`WS /pty/attach?id=<session>&target=<…>&cols=&rows=`. The path is
`/pty/attach` (not `/session/...`) to avoid colliding with the
`GET /session/:id` route. Auth rides the upgrade — the cookie travels
with it, no token in the URL. The PTY is spawned at the browser's
reported size so the tmux window and client grid agree from frame one
(no cold-start reflow garble).

Window behavior keeps state consistent with the CLI: every webapp
terminal is a real tmux window inside the container, so a
`yaac session attach` sees them too.

### Multiple viewers on one terminal

Two clients viewing the same terminal is handled by **tmux**, not a
server-side PTY registry. Every viewer gets its own grouped view
session, so each one is pinned to its window independently — of other
viewers and of the CLI — and the throwaway session dies on detach
while the windows live on.

**Not built / dropped:** the `ptyId` accept-frame and
`?ptyId=<existing>` reconnect-and-tee mechanism. Reconnects just
re-open with the same `id` + `target`, and tmux supplies the shared
state. There is no need to reintroduce `ptyId` unless a future client
wants byte-exact tee of a *non-tmux* PTY.

### Wire protocol

Implemented exactly as designed. Binary WS frames carry raw PTY bytes
in both directions (no base64). Text frames carry control messages:

- `{type:"resize", cols, rows}` — forwarded to `node-pty.resize()`.
- `{type:"signal", name:"SIGINT"|"SIGTERM"}` — forwarded to the PTY.
- `{type:"ping"}` → server replies `{type:"pong"}` — liveness.

Frames are disambiguated by WS frame kind: binary = data, text =
control.

### Close semantics

- Client closes the socket → the server kills the per-client view
  session inside the container (`tmux kill-session -t view-<hex>`),
  which detaches the exec'd client cleanly; it retries once at the
  grace deadline (in case the close raced the attach) and then
  force-kills the host-side PTY as the final fallback. There is no
  detach keystroke anymore — view sessions run `prefix None`, and
  killing the exec without a container-side detach leaks a zombie
  attached client that would pin the view session alive forever.
  The windows belong to the group and live on, so the container stays
  alive — closing a viewer never kills what runs in the window; only
  the explicit terminals/close endpoint does that.
- PTY process exits → server closes the socket with the exit code.
- Session resolve fails / not running → server sends an `{type:
  "error"}` frame and closes.
- Server restart → all sockets close; on reconnect the client
  re-opens with the same `id` + `target`. Scrollback survives
  because tmux runs inside the container, which outlives the server.

### Why not ttyd

Unchanged from the original rationale: ttyd isn't in the default
image, it wants to own the terminal (the desired first-tab behavior
is "attach an existing tmux session", not "spawn a new login shell"),
and auth/token sharing would be rolled from scratch anyway. `node-pty`
+ `kubectl exec -it` is a thin layer over an API we already depend on.

## Remaining work

### Interactive CLI commands on the PTY bridge — PENDING

Not built. The CLI still shells out to `kubectl exec -it` directly:

| CLI | Today | Target |
|---|---|---|
| `yaac session attach <id>` | `GET /session/:id/attach-info`, then local `kubectl exec -it … tmux attach` (`src/commands/session-attach.ts`) | `WS /pty/attach?id=…&target=agent`, pipe local TTY |
| `yaac session shell <id>` | `GET /session/:id/shell-info`, then local `kubectl exec -it … zsh` (`src/commands/session-shell.ts`) | `POST /session/:id/terminals` for a shell window, then `WS /pty/attach?id=…&target=window:@<id>`, pipe local TTY |
| `yaac session stream [project]` | HTTP poll of `POST /session/stream/next` + local `kubectl exec -it … tmux attach` per pick (`src/commands/session-stream.ts`) | `WS /session/stream`, pipe local TTY |
| `yaac auth update` | runs the whole flow locally — readline prompts and the `claude login` / `codex login` shell-outs run in the CLI process, persisting via the HTTP `/auth/*` endpoints (`src/commands/auth-update.ts`) | `WS /auth/update`, pipe local TTY |

What needs building:

- A CLI-side WS pump that pipes the local TTY to `/pty/attach` (raw
  mode, resize on `SIGWINCH`, forward `SIGINT`). Switch `session
  attach` and `session shell` to it. The `attach-info` / `shell-info`
  HTTP endpoints can stay as a `--raw` convenience for scripts.
- `WS /session/stream`: move the `pickNextStreamSession` state
  machine (today `POST /session/stream/next` in
  `src/server/routes/session.ts`, logic in `src/server/stream-picker.ts`)
  behind a WS. The server picks the next waiting session (or creates
  one), opens a PTY, streams it; on detach it picks the next; on "no
  more" it closes. The CLI side becomes a pure pump.
- `WS /auth/update`: run the interactive flow on the server,
  including the `claude login` / `codex login` shell-outs. Simple
  prompts travel as control messages; tool-login PTYs travel as
  binary frames. After this lands, the server is the only process
  that invokes those login CLIs, so credential bundles never transit
  the CLI process.

Net effect of this item: the server becomes the **only** process
that spawns container execs / login CLIs. Until it lands, that
invariant doesn't hold.

### Open external editor — PENDING

Not built. The webapp can't launch a process on the host, so "open
worktree in editor" needs a server endpoint:

- `POST /v1/open-editor` with body `{sessionId}`.
- Server resolves the worktree path, spawns the configured command
  (`code`, `cursor`, custom template), returns 204 on success.
- Command template lives in the server's prefs store; default is
  `code <path>`. Validate that the binary is on PATH and that the
  template substitutes `<path>` exactly once before spawning.
- Spawn is fire-and-forget; stderr is captured to the server log
  under the session id for debugging.

(Note: `yaac open` already exists but is unrelated — it opens the
*webapp* in a browser, not a worktree in an editor.)

### SPA deep-link fallback — PENDING (polish)

See "Static asset serving" above: add a `GET /<path>` →
`index.html` catch-all for non-API, non-asset GETs when the bundle
is present.

## Test strategy

Per `CLAUDE.md`. Shipped coverage:

- **Unit**: `test/unit/server/events.test.ts` (snapshot hub: connect
  sends snapshot, diff-suppressed re-broadcast),
  `test/unit/server/pty-bridge.test.ts` (control-message parsing,
  target parsing, bridge wiring), `test/unit/server/web-auth.test.ts`
  (`/auth/bootstrap`: valid → cookie; reused → null; expired → null;
  mismatch → null; host-header allow/deny),
  `test/unit/server/open-webapp.test.ts`,
  `test/unit/frontend/bootstrap.test.ts`.
- **API/E2E**: `test/api/bootstrap-flow.test.ts` (code → cookie →
  authed request; reuse 401), `test/e2e-cli/server-ws.test.ts`
  (connect `/events`, observe `snapshot` on connect and after a CLI
  session create; PTY `/pty/attach` round-trip — write `echo hi`,
  read the bytes back).

Tests still owed by the remaining work:

- `WS /session/stream` transitions between sessions without the
  client re-opening.
- `WS /auth/update` runs an end-to-end API-key flow and persists via
  the existing credentials endpoints.
- The CLI WS pump for `session attach` / `session shell` (e2e).
- `POST /v1/open-editor`: spawns the configured command; rejects a
  binary not on PATH and a template that doesn't substitute `<path>`
  exactly once.
- SPA deep-link fallback returns `index.html` for an unknown GET.

**Image management**: no new container images, shipped or pending.

## Delivery

Shipped (each behind its own PR with unit + e2e tests):

1. `/events` WS server + `snapshot` backfill on connect, bearer +
   cookie auth on the upgrade. Driven by the background loop +
   `onSessionListChanged`.
2. PTY bridge: `WS /pty/attach` with `agent` / `shell:<name>` /
   `window:@<id>` targets.
3. Static serving + `/auth/bootstrap` + `/auth/bootstrap-code` +
   Host-header + CORS + CSP. `pnpm build` wires the frontend bundle
   into `dist/frontend/`.
4. Webapp itself (tracked in `webapp-frontend.md`): terminals,
   tiling/tabs window manager, bootstrap splash.

Remaining (each its own PR with unit + e2e tests):

5. CLI WS pump; switch `yaac session attach` / `yaac session shell`
   onto `WS /pty/attach`. Keep `attach-info` / `shell-info` behind a
   `--raw` flag.
6. `WS /session/stream` + port `yaac session stream` onto it.
7. `WS /auth/update` + port `yaac auth update` onto it. Tool-login
   shell-outs (`claude login`, `codex login`) move inside the server.
8. `POST /v1/open-editor` + prefs storage for the editor template.
9. SPA deep-link fallback route.

## Open questions

1. **Access control for `/auth/update`.** Interactive OAuth flows
   produce real tokens in memory on the server side. Scope this to
   authenticated clients only (same as everything else), or add a
   per-request confirmation in the UI?
2. **PTY reconnect window.** With `ptyId` dropped, reconnect relies
   on tmux: detached tmux sessions/windows persist indefinitely
   (cheap), and the host-side PTY is torn down on disconnect. Confirm
   that's the desired behavior for every target (it is for `agent`
   and `window`; for `shell` a detach also preserves the session,
   which differs from the old "kill the bare zsh" idea — decide
   whether scratch shells should auto-reap).
3. **Backpressure on `/events`.** A slow subscriber shouldn't
   balloon memory. The hub currently drops a connection whose `send`
   throws; consider an explicit `{type:"overrun"}` close so the
   client reconnects and re-snapshots.
4. **Bootstrap code rotation.** Single-use means the server mints a
   new code after every successful exchange. With the 24h TTL, an
   unused code sits in the log for up to a day; that's an accepted
   tradeoff (see "Shipped"). Revisit only if it proves noisy.
5. **HttpOnly vs. JS-readable cookie.** HttpOnly means the JS can't
   detect auth loss without a round-trip. Accepted — 401 handling
   does the detection. Confirm no flow needs client-side auth
   visibility.
</content>
