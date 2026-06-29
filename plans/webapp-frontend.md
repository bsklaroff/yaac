# Webapp frontend

A local-first web app that puts a GUI over everything yaac does
today from the CLI. This plan covers the frontend **architecture**:
delivery, data flow, tech choices, and phases. UI/UX design lives
in `webapp-ux.md`. The HTTP half of the daemon backend, the
WebSocket event stream, the PTY bridge, static-asset serving, and
the auth bootstrap this plan relies on are all implemented (see
`src/daemon/`); the daemon-side roadmap continues in
`webapp-daemon-follow-up.md`.

## Goals

- CLI parity surfaced through a daemon-backed webapp: every
  `yaac <command>` is reachable from the app.
- Live state (session list, status, blocked hosts, prewarm) driven
  entirely by the daemon's `/events` stream — no client-side
  polling.
- Each session opens as a first-class tabbed window with embedded
  terminals via the daemon's PTY bridge.
- No second source of truth. The webapp drives the daemon; the
  daemon drives the same on-disk state and container labels the CLI
  uses. Webapp and CLI can be mixed freely.
- No credential regressions. Credentials are entered via daemon
  endpoints, stored under `~/.yaac/.credentials/`, and injected by
  the proxy sidecar exactly as today.

## Non-goals (v1)

- Replacing the CLI.
- Hosted / multi-user mode. The daemon binds 127.0.0.1 only.
- Remote access. Users tunnel themselves if they want it; the app
  is not a remote-access product.
- Re-implementing any session logic in the frontend. The frontend
  is a presentation layer over the daemon API.

## Process layout

```
 ┌──────────────────────────────────────────────────────────┐
 │ browser tab (http://127.0.0.1:<port>)                    │
 │                                                          │
 │   React SPA  ──fetch────▶  HTTP  (same-origin)           │
 │             ──WebSocket─▶  /events                       │
 │             ──WebSocket─▶  /pty/attach?id=…&target=…     │
 │                                                          │
 │   HttpOnly session cookie set via /auth/bootstrap        │
 └──────────────────────────────────────────────────────────┘
                             │
                             ▼
                     ┌─────────────────────┐
                     │  yaac daemon        │
                     │  (src/daemon/)      │
                     │  serves SPA bundle  │
                     │  + HTTP + WS API    │
                     └─────────────────────┘
                             ▲
                             │
                     ┌──────────────┐
                     │  yaac CLI    │ ── bearer from ~/.yaac/.daemon.lock
                     └──────────────┘
```

- **Daemon** serves the SPA bundle at `/` (and `/assets/*` for
  hashed assets), exposes the HTTP + WS API under bare top-level
  paths (`/session`, `/project`, `/tool`, `/auth`, `/prewarm`,
  `/health`, `/events`, `/pty`), and handles browser auth via a
  bootstrap endpoint. Same-origin for the webapp, so no CORS.
- **Browser** holds session state in an `HttpOnly` cookie set by
  `/auth/bootstrap`. Cookies flow on both HTTP and WebSocket
  upgrades — no bearer in URL query strings.
- **CLI** continues to authenticate with the bearer in
  `~/.yaac/.daemon.lock`. The two auth modes coexist on the same
  API surface; the webapp just uses a different credential.

## First-run flow

1. User starts the daemon: `yaac daemon start`.
2. Daemon prints `open http://127.0.0.1:<port>/?bootstrap=<code>`.
3. User opens the URL (browser, new tab, or `yaac open`, which
   ensures the daemon is up, fetches a fresh bootstrap code over
   the authenticated API, and shells out to `xdg-open` / `open`).
4. SPA reads `?bootstrap=` from the URL, `POST`s it to
   `/auth/bootstrap`, receives a `Set-Cookie: yaac_session=…;
   HttpOnly; SameSite=Strict; Path=/`. Cleans the bootstrap code
   out of the URL via `history.replaceState`.
5. Subsequent requests carry the cookie automatically. Cookie TTL
   matches the daemon's lifetime; a daemon restart invalidates all
   sessions and the user re-bootstraps from a new URL.

The bootstrap code is single-use and time-bounded (24h TTL), and
rotates on every successful exchange. It's printed by the daemon
and appears in the `yaac daemon logs` output, so users who lost the
URL can always retrieve it (or just run `yaac open`).

## Tech choices

- **Framework**: React + Vite + TypeScript, scaffolded under
  `src/frontend/`.
- **Styling**: Tailwind. A future theming pass adds a CSS-variable
  layer on top for user-pickable accent colors.
- **UI primitives**: `@base-ui/react` for accessible dialogs,
  menus, and radio groups (new-project / new-session modals,
  settings, per-session action menus). `lucide-react` for icons.
- **State**: React Query holds the daemon snapshot in a single
  query key, hydrated over the events WebSocket (see "Events
  WebSocket" below) — there's no `queryFn`; `useEvents` populates
  the cache via `setQueryData` and `useSnapshot` reads it back.
  Zustand for local UI state (selected project/session, open tabs,
  pane layouts, optimistic provisioning/delete tracking,
  preferences).
- **Terminal**: `xterm.js` with `@xterm/addon-fit` (the only addon
  wired). Each xterm instance is backed by a native WebSocket to
  the daemon's PTY bridge — binary frames = PTY data, text frames =
  JSON control (resize).
- **Editor (config, files)**: pending. The Phase C config editor
  and Phase D file editor still need an editor library chosen; a
  generated JSON schema for `yaac-config.json` (from the
  `YaacConfig` types in `src/shared/types.ts`) would let
  auto-complete and validation match the CLI parser, but is not
  built yet.
- **Shared types**: the frontend lives in the same workspace as the
  CLI, so it imports types from `src/shared/types.ts` directly via
  the `@/*` tsconfig path alias (`@/shared/types`).
- **Dependencies**: exact versions per `CLAUDE.md`
  (`pnpm add -E …`).

## Dev vs. production

- **Dev**: `pnpm frontend:dev` runs Vite on `:1420`. The Vite config
  proxies the bare API prefixes (`/session`, `/project`, `/tool`,
  `/auth`, `/prewarm`, `/health`) and the WebSocket endpoints
  (`/events`, `/pty`) to the daemon's HTTP port, reading the actual
  port from `~/.yaac/.daemon.lock`. WebSocket upgrades pass through
  the same proxy. Hot-reload stays fast; cookies work because the
  browser treats the Vite origin as the sole origin.
- **Prod**: `pnpm frontend:build` emits a static bundle into
  `dist/frontend/`. `pnpm build` runs that as part of the full
  build. The daemon serves the bundle at its own port. No Vite in
  production. Same-origin end to end, no CORS.

## Daemon integration

Three transports, all implemented (see `src/daemon/`).

### HTTP

The SPA uses `fetch()` directly. No IPC layer — same-origin + cookie
auth means the browser handles credentials transparently. A thin
`apiClient` wrapper adds: (a) throw-on-non-2xx (as a typed
`ApiError`), (b) JSON encode/decode, (c) a typed 401 the app turns
into a bootstrap-needed redirect (back to the welcome screen
prompting for a fresh bootstrap URL).

All UI read paths (projects, sessions, session detail, blocked
hosts, prompt, credentials listing, tool default) and write paths
(create session, delete session, add project, save credentials,
set default tool) go through `apiClient`.

### Events WebSocket

The browser opens `ws://127.0.0.1:<port>/events`. The cookie
travels with the upgrade request automatically; no token in the
URL.

The daemon pushes a single `snapshot` frame on connect and again
after each background-loop tick (deduped — it only broadcasts when
the snapshot changed). The frontend writes the snapshot wholesale
into one React Query key on every frame; each new snapshot replaces
the previous one. There are no granular per-entity events or
cache-patch reducer today — the snapshot is authoritative and there
is no client-side polling. (A finer-grained event stream that
patches individual query keys is possible future work, but the wire
protocol currently carries only `snapshot`.)

Reconnect logic: exponential backoff starting at 500 ms, capped at
10 s. On reconnect, the fresh `snapshot` replaces the cached state
— no diff merge needed. A 401 on upgrade is treated like an HTTP
401 and prompts for re-bootstrap.

### PTY WebSockets

One socket per open terminal tab:
`ws://127.0.0.1:<port>/pty/attach?id=<sessionId>&target=<target>`
(plus `cols`/`rows` query params so the daemon spawns the PTY at the
right dimensions from the first frame).

| Tab source | target |
|---|---|
| Default agent tab for a session | `agent` |
| "+ new shell" (scratch tmux session) | `shell` / `shell:<name>` |
| Extra tmux window (e.g. an initCommands dev server) | `window:@<id>` |

Cookie auth on the upgrade. Binary frames stream straight to
`xterm.write()` and from `xterm.onData()`. Control frames (resize)
are JSON text frames, per the daemon's wire protocol.

## Delivery phases

### Phase A — scaffolding (COMPLETED)

- Daemon: static serving, `/auth/bootstrap`, cookie middleware,
  Host-header check. Shipped (see `webapp-daemon-follow-up.md`).
- Frontend: `apiClient`, `useEvents` hook bound to the events WS,
  `<SessionTerminal>` component wrapping the PTY WS protocol, a
  `BootstrapSplash` screen for first-open / expired-session states.

### Phase B — webapp MVP (COMPLETED)

The v1 scope in `webapp-ux.md`: project rail + sidebar with live
data, session view with the attach tab and additional-tab creation,
new-session + new-project modals, optimistic delete flows, and a
credentials listing (read-only) in the settings modal.

### Phase C — full CLI parity (PARTIALLY DONE)

Done so far: default-tool switcher (settings → General), adding a
git HTTPS credential (host pattern + token), and the read-only
credentials listing.

Remaining gaps:

- **Tool OAuth via embedded PTY modal.** Claude / Codex login run
  inside a daemon-owned PTY surfaced in a modal. Not built.
- **Project config editor (form + raw).** Edit `yaac-config.json`
  from the app. Not built (no editor library chosen yet).
- **Deleted-sessions view.** Surface restartable deleted sessions
  in the UI, wired to the existing `deletedApi.getDeletedSessions`
  client (the API client and its unit test exist; no view consumes
  it yet).
- **GitHub token management** beyond the generic git-credential add.
- **"Open worktree in editor."** Needs a new daemon endpoint and a
  matching client (neither exists today).

### Phase D — post-parity

Shipped: **split-pane terminals** — a tiling window manager with
per-terminal pane cards, drag, split, resize, and a tabs/tiles
toggle (`layout.ts`, `SessionView`).

Pending: file browser + inline editor, diff sidebar, monitor
dashboard, notifications, rich prompt history. Most of these require
new daemon endpoints (spec them alongside the daemon source in
`src/daemon/` once scoped).

Phase B is the first version users open. Phase C reaches CLI parity.
Phase D is the reason the webapp exists beyond the CLI.

## Security and trust

The attack surface is "arbitrary webpage on the user's machine
pokes at `127.0.0.1:<daemon-port>`". Defenses, in order of
importance:

- **Host-header check.** The daemon rejects any request whose
  `Host` header's hostname isn't `127.0.0.1` or `localhost`. This
  blocks DNS rebinding attacks that resolve an attacker domain to
  127.0.0.1. (Only the hostname is checked, not the port, so a
  port-forward still works.)
- **CORS denied.** The daemon doesn't grant cross-origin access:
  same-origin requests don't need CORS anyway, and cross-site
  preflights are rejected (`OPTIONS` → 405). Cross-origin `fetch`
  from another site gets a browser-level block on reads.
- **Cookies `SameSite=Strict`.** Cross-origin navigations that try
  to POST to the daemon don't send the session cookie, so any
  state-changing request from another origin gets 401. (No `Secure`
  flag — the daemon is http on loopback, and browsers reject Secure
  cookies over http.)
- **Bootstrap is single-use and time-bounded.** The code is 256-bit
  (so brute-forcing is not feasible), rotates on every successful
  exchange (so a consumed code can't be replayed), and expires
  after a 24h TTL. The long TTL is deliberate: the code is
  single-use and already retrievable from `yaac daemon logs` for
  the daemon's lifetime, so a short TTL adds little and creates a
  real "code expired before I opened the browser" papercut.
- **Never log the cookie or bootstrap code.** The daemon logs
  `/auth/bootstrap` requests as `bootstrap ok` / `bootstrap fail`
  without the code value.
- **Credentials stay on the daemon.** OAuth flows run inside a PTY
  owned by the daemon — secrets never cross the HTTP boundary in
  cleartext beyond the initial input (which is `https://` to the
  tool's login CLI running inside the daemon).
- **CSP.** `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:
  wss:; base-uri 'self'; frame-ancestors 'none'`. The one
  relaxation is `style-src 'unsafe-inline'` — Vite/React inject a
  little inline style; tightening to a hash allowlist is a later
  polish pass (TODO). Forwarded ports open in a new tab rather than
  an iframe, so no port-preview CSP relaxation in the main origin.

## Test strategy

- **Component / logic**: Vitest (with `@testing-library/react`
  available). Current frontend coverage is lib/logic-level — the
  `apiClient`, bootstrap helpers, clipboard key handling, the tiling
  layout engine, the Zustand store, the deleted-sessions and
  terminals API clients, and the provision-session hook. Full
  component-render tests of the sidebar, session view, config
  editor, and auth modal are not in place yet.
- **E2E UI**: not present yet. Playwright against a prod-mode daemon
  that serves the built SPA (bootstrap a session in the harness,
  drive new-project / new-session happy paths, confirm the attach
  tab reads a known echo from the PTY, confirm delete-session
  reflects on the next snapshot) is the intended approach but isn't
  wired up.
- **Node tests unaffected.** No new CLI arguments or exported
  functions in `src/**` are required by the frontend, so the
  unit/e2e coverage rules in `CLAUDE.md` don't add requirements
  here — anything the webapp calls is already a daemon endpoint with
  its own test.

## Open questions

1. **Auto-open on daemon start.** `yaac open` exists and launches
   the browser straight into the authenticated webapp (with a
   `--no-browser` flag that just prints the URL). Whether
   `yaac daemon start` should also auto-open on first start is still
   open; for now starting the daemon prints the URL and the user
   runs `yaac open` (or clicks the printed link).
2. **Multiple browser tabs.** Cookie auth means multiple tabs share
   one session. But each tab opens its own events WS and gets its
   own snapshot. That's fine for reads; React Query caches are
   per-tab. Should we use `BroadcastChannel` to dedupe the events
   WS to one per origin? Defer until it's a real problem.
3. **PTY reconnect window.** Tracked on the daemon side in
   `webapp-daemon-follow-up.md`. The frontend just needs a UX for
   "reconnecting…" banners.
4. **Session cookie lifetime.** Matches the daemon's lifetime (lost
   on restart). Users running long-lived daemons get months-long
   cookies; acceptable since the cookie is `HttpOnly` and
   `SameSite=Strict`. Rotate on a fixed schedule later if we see
   users leaving stale daemons up.
