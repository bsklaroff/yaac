# Webapp frontend

A local-first web app that puts a GUI over everything yaac does
today from the CLI. This plan covers the frontend **architecture**:
delivery, data flow, tech choices, and phases. UI/UX design lives
in `webapp-ux.md`. The HTTP half of the daemon backend is already
implemented (see `src/daemon/`); the WebSocket event stream, PTY
bridge, static-asset serving, and auth bootstrap this plan relies
on are tracked in `webapp-daemon-follow-up.md` and must ship before
Phase A here.

## Goals

- CLI parity surfaced through a daemon-backed webapp: every
  `yaac <command>` is reachable from the app.
- Live state (session list, status, blocked hosts, prewarm) driven
  entirely by the daemon's `/v1/events` stream — no client-side
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
 │             ──WebSocket─▶  /v1/events                    │
 │             ──WebSocket─▶  /v1/sessions/:id/ptys/:ptyId  │
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
                     │  yaac CLI    │ ── bearer from ~/.yaac/.daemon-lock.json
                     └──────────────┘
```

- **Daemon** serves the SPA bundle at `/` (and `/static/*` for
  assets), exposes the HTTP + WS API under `/v1/*`, and handles
  browser auth via a bootstrap endpoint. Same-origin for the
  webapp, so no CORS.
- **Browser** holds session state in a short-lived `HttpOnly`
  cookie set by `/auth/bootstrap`. Cookies flow on both HTTP and
  WebSocket upgrades — no bearer in URL query strings.
- **CLI** continues to authenticate with the bearer in
  `~/.yaac/.daemon-lock.json`. The two auth modes coexist on the
  same API surface; the webapp just uses a different credential.

## First-run flow

1. User starts the daemon: `yaac daemon start`.
2. Daemon prints `open http://127.0.0.1:<port>/?bootstrap=<code>`.
3. User opens the URL (browser, new tab, or `yaac open` that shells
   out to `xdg-open` / `open`).
4. SPA reads `?bootstrap=` from the URL, `POST`s it to
   `/auth/bootstrap`, receives a `Set-Cookie: yaac_session=…;
   HttpOnly; SameSite=Strict; Path=/`. Cleans the bootstrap code
   out of the URL via `history.replaceState`.
5. Subsequent requests carry the cookie automatically. Cookie TTL
   matches the daemon's lifetime; a daemon restart invalidates all
   sessions and the user re-bootstraps from a new URL.

The bootstrap code is single-use and time-bounded (~60 s). It's
printed by the daemon and appears in the `yaac daemon logs` output,
so users who lost the URL can always retrieve it.

## Tech choices

- **Framework**: React + Vite + TypeScript. Already scaffolded
  under `src/frontend/`.
- **Styling**: Tailwind. A future theming pass adds a CSS-variable
  layer on top for user-pickable accent colors.
- **State**: React Query for HTTP, backed by an event-stream reducer
  that invalidates keys on `/v1/events` messages. Zustand for local
  UI state (open tabs, panel widths, preferences).
- **Terminal**: `xterm.js` + `xterm-addon-fit` +
  `xterm-addon-web-links`. Each xterm instance is backed by a
  native WebSocket to the daemon's PTY bridge — binary frames =
  PTY data, text frames = JSON control.
- **Editor (config, files)**: Monaco via `@monaco-editor/react`.
  JSON schema for `yaac-config.json` generated from
  `src/types.ts YaacConfig` so auto-complete and validation match
  the CLI parser.
- **Shared types**: the frontend lives in the same workspace as the
  CLI, so it imports types from `src/types.ts` directly. A small
  tsconfig path alias keeps the import clean.
- **Dependencies**: exact versions per `CLAUDE.md`
  (`pnpm add -E …`).

## Dev vs. production

- **Dev**: `pnpm frontend:dev` runs Vite on `:1420`. The Vite config
  proxies `/v1/*` and `/auth/*` to the daemon's HTTP port. WebSocket
  upgrades pass through the same proxy. Hot-reload stays fast;
  cookies work because the browser treats the Vite origin as the
  sole origin.
- **Prod**: `pnpm frontend:build` emits a static bundle. `pnpm
  build` copies it into the daemon-served `dist/frontend/`. The
  daemon serves the bundle at its own port. No Vite in production.
  Same-origin end to end, no CORS.

## Daemon integration

Three transports. The HTTP transport is already implemented (see
`src/daemon/routes/`); the events WebSocket, PTY WebSockets, static
serving, and `/auth/bootstrap` are tracked in
`webapp-daemon-follow-up.md` and must land before the frontend can
consume them.

### HTTP

The SPA uses `fetch()` directly. No IPC layer — same-origin + cookie
auth means the browser handles credentials transparently. A thin
`apiClient` wrapper adds: (a) throw-on-non-2xx, (b) JSON
encode/decode, (c) a bootstrap-needed redirect (401 → go back to
welcome screen prompting for a fresh bootstrap URL).

All UI read paths (projects, sessions, session detail, blocked
hosts, prompt, credentials listing, tool default) and write paths
(create session, delete session, add project, edit config, save
credentials, set default tool) go through `apiClient`.

### Events WebSocket

The browser opens `ws://127.0.0.1:<port>/v1/events`. The cookie
travels with the upgrade request automatically; no token in the
URL.

On connect, the daemon sends a `snapshot` event. The frontend
hydrates React Query caches from the snapshot, then applies each
subsequent event as a cache patch. No client-side polling — the
snapshot + event stream is authoritative.

Reconnect logic: exponential backoff starting at 500 ms, capped at
10 s. On reconnect, the fresh `snapshot` replaces the cached state
— no diff merge needed. 401 on upgrade → treat like an HTTP 401 and
prompt for re-bootstrap.

### PTY WebSockets

One socket per open terminal tab:
`ws://127.0.0.1:<port>/v1/sessions/:id/ptys/:ptyId?mode=<mode>`.

| Tab source | mode |
|---|---|
| Default first tab for a session | `attach` |
| "+ new terminal" (in-tmux) | `window` |
| Re-open closed tab for same ptyId | `attach` to existing ptyId |

Cookie auth on the upgrade. Binary frames stream straight to
`xterm.write()` and from `xterm.onData()`. Control frames (resize,
signal, ping) are JSON text frames, per the daemon's wire protocol.

## Delivery phases

### Phase A — scaffolding

- Daemon: add static serving, `/auth/bootstrap`, cookie middleware,
  Host-header check. Ship in `webapp-daemon-follow-up.md`.
- Frontend: `apiClient`, `useEvents` hook bound to the events WS,
  `<Terminal>` component wrapping the PTY WS protocol, a bootstrap
  splash screen for first-open / expired-session states.
- Smoke test: a dev-only debug panel that lists sessions and shows
  live events.

### Phase B — webapp MVP

Implements the v1 scope in `webapp-ux.md`: sidebar with live data,
session view with the attach tab and additional-tab creation,
new-session + new-project modals, delete flows, credentials
listing (read-only).

### Phase C — full CLI parity

Adds edit flows: GitHub token management, Claude / Codex OAuth via
embedded PTY modal, project config editor (form + raw), default
tool switcher, deleted-sessions view. "Open worktree in editor"
wired to `POST /v1/open-editor`.

### Phase D — post-parity

File browser + inline editor, diff sidebar, split-pane terminals,
monitor dashboard, notifications, rich prompt history. Most of
these require new daemon endpoints (spec them alongside the daemon
source in `src/daemon/` once scoped).

Ship Phase A as a hidden/debug route. Phase B is the first version
users open. Phase C reaches CLI parity. Phase D is the reason the
webapp exists beyond the CLI.

## Security and trust

The attack surface is "arbitrary webpage on the user's machine
pokes at `127.0.0.1:<daemon-port>`". Defenses, in order of
importance:

- **Host-header check.** The daemon rejects any request whose
  `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>`.
  This blocks DNS rebinding attacks that resolve an attacker
  domain to 127.0.0.1.
- **CORS denied.** The daemon only sets
  `Access-Control-Allow-Origin` for same-origin requests (which
  don't need CORS anyway). Cross-origin `fetch` from another site
  gets a browser-level block on reads. Preflights are rejected.
- **Cookies `SameSite=Strict`.** Cross-origin navigations that try
  to POST to the daemon don't send the session cookie, so any
  state-changing request from another origin gets 401.
- **Bootstrap is single-use and time-bounded.** An attacker who
  guesses the code window already has the URL. Code has enough
  entropy (256 bits) that brute-forcing is not feasible.
- **Never log the cookie or bootstrap code.** The daemon logs
  `/auth/bootstrap` requests as `bootstrap ok` / `bootstrap fail`
  without the code value.
- **Credentials stay on the daemon.** OAuth flows run inside a PTY
  owned by the daemon — secrets never cross the HTTP boundary in
  cleartext beyond the initial input (which is `https://` to the
  tool's login CLI running inside the daemon).
- **CSP.** `default-src 'self'; connect-src 'self' ws://…;
  img-src 'self' data:`. No `unsafe-inline` — Vite inlines styles
  at build, and we take the hash-allowlist hit. Forwarded ports
  open in a new tab rather than an iframe, so no port-preview
  CSP relaxation in the main origin.

## Test strategy

- **Component**: Vitest + React Testing Library for sidebar,
  session view, config editor, auth modal. Mock the HTTP client
  and event stream at the `apiClient` / `useEvents` boundary — no
  real daemon in component tests.
- **E2E UI**: Playwright against a prod-mode daemon that serves the
  built SPA. Bootstrap a session in the test harness, drive the
  covered flows: new-project happy path, new-session happy path,
  attach tab reads a known echo from the PTY, delete-session
  reflects on the `session.exited` event.
- **Node tests unaffected.** No new CLI arguments or exported
  functions in `src/**`, so the unit/e2e coverage rules in
  `CLAUDE.md` don't add requirements for the frontend — anything
  the webapp calls is already a daemon endpoint with its own test.

## Open questions

1. **Bootstrap URL UX.** The daemon prints a URL with a one-time
   code on start. Should `yaac daemon start` also open the browser
   automatically (via `xdg-open` / `open`)? Probably yes on first
   start, off by default on restart. Make it a flag.
2. **Multiple browser tabs.** Cookie auth means multiple tabs share
   one session. But each tab opens its own events WS and gets its
   own snapshot. That's fine for reads; confirm no race on shared
   caches across tabs (React Query is per-tab). Should we use
   `BroadcastChannel` to dedupe the events WS to one per origin?
   Defer until it's a real problem.
3. **PTY reconnect window.** Tracked on the daemon side in
   `webapp-daemon-follow-up.md`. The frontend just needs a UX for
   "reconnecting…" banners.
4. **Session cookie lifetime.** Matches the daemon's lifetime (lost
   on restart). Users running long-lived daemons get months-long
   cookies; acceptable since the cookie is `HttpOnly` and
   `SameSite=Strict`. Rotate on a fixed schedule later if we see
   users leaving stale daemons up.
