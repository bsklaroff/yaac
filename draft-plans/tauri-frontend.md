# Tauri frontend

A desktop app that puts a GUI over everything yaac does today from
the CLI. This plan covers the frontend **architecture**: process
layout, data flow, tech choices, and delivery phases. UI/UX design
lives in `tauri-ux.md`; the backend it talks to is in
`tauri-daemon.md`, and this plan assumes the daemon is already
implemented and its HTTP + WebSocket API is stable.

## Goals

- CLI parity surfaced through a daemon-backed GUI: every
  `yaac <command>` is reachable from the app.
- Live state (session list, status, blocked hosts, prewarm) driven
  entirely by the daemon's `/v1/events` stream — no client-side
  polling.
- Each session opens as a first-class tabbed window with embedded
  terminals via the daemon's PTY bridge.
- No second source of truth. The GUI drives the daemon; the daemon
  drives the same on-disk state and container labels the CLI uses.
  GUI and CLI can be mixed freely.
- No credential regressions. Real tokens never touch the Tauri
  process — credentials are entered via daemon endpoints, stored
  under `~/.yaac/.credentials/`, and injected by the proxy sidecar
  exactly as today.

## Non-goals (v1)

- Replacing the CLI.
- Hosted / multi-user mode.
- Windows support (matches current yaac — macOS + Linux only).
- Re-implementing any session logic in the frontend. The frontend
  is a presentation layer over the daemon API.

## Process layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri app (Rust shell + webview)                                 │
│                                                                  │
│  ┌───────────┐   invoke()    ┌──────────────────────────────┐   │
│  │ frontend  │◀─────────────▶│ Rust tauri::command handlers │   │
│  │ (web UI)  │   events      │   - daemon lifecycle         │   │
│  └─────┬─────┘               │   - api client (bearer auth) │   │
│        │                     │   - window/tray menu         │   │
│        │ xterm.js            └──────────────┬───────────────┘   │
│        │ (WS to daemon)                     │                   │
└────────┼────────────────────────────────────┼───────────────────┘
         │                                    │
         │                            HTTP + WS on 127.0.0.1
         │                                    │
         └───────────────────────────────────▶│
                      PTY WS                  ▼
                                    ┌─────────────────────┐
                                    │  yaac daemon        │
                                    │  (tauri-daemon.md)  │
                                    └─────────────────────┘
```

- **Rust shell** owns: window lifecycle, daemon sidecar spawn,
  handshake parsing (port + bearer secret from the daemon's stdout),
  and a thin HTTP client that injects the bearer header.
- **Webview** owns: all rendering, state management, and direct
  WebSocket connections for `/events` and PTYs. WebSocket frames
  carry PTY data straight from the daemon to xterm.js — Rust is not
  in the hot path for terminal I/O.

## Tech choices

- **Shell**: Tauri 2.x. System webview keeps installed size small;
  the sidecar-process pattern (`tauri.conf.json > bundle.externalBin`)
  is first-class for bundling the daemon.
- **Frontend**: React + Vite + TypeScript. Tailwind for styling.
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
- **Shared types**: generate a `.d.ts` from `src/types.ts` consumed
  by the frontend. Keeps `YaacConfig`, `ProjectMeta`,
  `GithubTokenEntry`, `AgentTool`, `AttachOutcome` in one place.
- **Dependencies**: exact versions per `CLAUDE.md`
  (`pnpm add -E …`).

## Daemon integration

Three transports, all described in full in `tauri-daemon.md`. This
section maps the frontend's interaction model to those transports.

### HTTP (proxied via Rust IPC)

The webview does **not** `fetch` the daemon directly — Rust holds
the bearer secret and is the only process that proxies requests.
One Tauri `invoke` command per HTTP verb (`daemon_get`,
`daemon_post`, `daemon_put`, `daemon_delete`) takes a path and body
and returns `{status, json}`. This keeps the bearer out of the
webview and sets up a natural place to add retry / offline handling
later.

All UI read paths (projects, sessions, session detail, blocked
hosts, prompt, credentials listing, tool default) and write paths
(create session, delete session, add project, edit config, save
credentials, set default tool) go through this layer.

### Events WebSocket

The webview opens `ws://127.0.0.1:<port>/v1/events`. The Rust side
hands the URL + bearer to the webview at startup through a one-shot
`invoke`; the webview then owns the socket.

On connect, the daemon sends a `snapshot` event. The frontend
hydrates React Query caches from the snapshot, then applies each
subsequent event as a cache patch. No client-side polling — the
snapshot + event stream is authoritative.

Reconnect logic: exponential backoff starting at 500 ms, capped at
10 s. On reconnect, the fresh `snapshot` replaces the cached state
— no diff merge needed.

### PTY WebSockets

One socket per open terminal tab, directly from the webview:
`ws://127.0.0.1:<port>/v1/sessions/:id/ptys/:ptyId?mode=<mode>`.

| Tab source | mode |
|---|---|
| Default first tab for a session | `attach` |
| "+ new terminal" (in-tmux) | `window` |
| Re-open closed tab for same ptyId | `attach` to existing ptyId |

Binary frames stream straight to `xterm.write()` and from
`xterm.onData()`. Control frames (resize, signal, ping) are JSON
text frames, per the daemon's wire protocol.

## Delivery phases

### Phase A — scaffolding

- `create-tauri-app` scaffold committed under `gui/` (or similar).
- Rust side: spawn the daemon via `bundle.externalBin`, parse the
  handshake line, store port + bearer for the session.
- Frontend side: `daemon_*` invoke commands, `apiClient` wrapper,
  `useEvents` hook bound to the events WS, `<Terminal>` component
  wrapping the PTY WS protocol.
- Smoke test: a dev-only debug panel that lists sessions and shows
  live events.

### Phase B — GUI MVP

Implements the v1 scope in `tauri-ux.md`: sidebar with live data,
session view with the attach tab and additional-tab creation,
new-session + new-project modals, delete flows, credentials
listing (read-only).

### Phase C — full CLI parity

Adds edit flows: GitHub token management, Claude / Codex OAuth via
embedded PTY modal, project config editor (form + raw), default
tool switcher, deleted-sessions view.

### Phase D — post-parity

File browser + inline editor, diff sidebar, port preview tabs,
split-pane terminals, monitor dashboard. Most of these require new
daemon endpoints (track in `tauri-daemon.md` once scoped).

Ship Phase A behind a feature flag / side binary. Phase B is the
first version users install. Phase C reaches CLI parity. Phase D is
the reason the GUI exists beyond the CLI.

## Security and trust

- The frontend never sees real tokens. Credential inputs in the
  auth modal are write-only; the masked listing comes from the
  daemon. OAuth flows run inside a PTY owned by the daemon —
  secrets never cross the HTTP boundary in cleartext beyond the
  initial input.
- The bearer secret is held by the Rust layer only; webview HTTP
  goes through `invoke`. For WebSocket connections the webview
  holds the bearer at connect time — an accepted compromise since
  Tauri's WS APIs need the URL in the webview context (see open
  question below).
- The Tauri allowlist starts empty and grows only per feature:
  `shell:open` for "open worktree in editor", filesystem read only
  inside `~/.yaac/` if the frontend ever needs direct fs access
  (it shouldn't — everything goes through the daemon).
- CSP is strict in v1 (no iframes, no remote resources). Relaxed
  when the port-preview feature lands, ideally by moving port
  previews into a separate Tauri window with its own looser policy
  rather than loosening the main window's CSP.

## Test strategy

- **Component**: Vitest + React Testing Library for sidebar,
  session view, config editor, auth modal. Mock the HTTP client
  and event stream at the `apiClient` / `useEvents` boundary — no
  real daemon in component tests.
- **E2E UI**: Playwright against a bundled dev build, pointed at a
  real daemon started from the CLI. Covers new-project happy path,
  new-session happy path, attach tab reads a known echo from the
  PTY, delete-session reflects on the `session.exited` event.
- **Node tests unaffected.** No new CLI arguments or exported
  functions in `src/**` (the daemon adds its own; see
  `tauri-daemon.md`), so the unit/e2e coverage rules in `CLAUDE.md`
  don't add requirements here — anything the GUI calls is already
  a daemon endpoint with its own test.

## Open questions

1. **PTY WebSocket auth**. Passing the bearer in the URL query
   string leaks it into webview history / Rust logs. Using
   `Sec-WebSocket-Protocol` requires the daemon to accept arbitrary
   subprotocol tokens. Pick one and document it in
   `tauri-daemon.md` during Phase A.
2. **Port preview isolation**. Iframing a forwarded port in the
   main window means relaxing CSP site-wide. A secondary webview or
   native window per preview keeps the main window strict; this is
   probably the right direction but adds window-management
   complexity.
3. **Daemon version skew**. The GUI bundles a daemon binary but
   users may have a newer CLI-side yaac installed. If the bundled
   daemon is older than the CLI, state-file schema changes could
   bite. Options: bundle only one, or ship the GUI's daemon as a
   separate `yaac-gui-daemon` that shares state with the CLI. Punt
   to Phase C.
4. **Daemon spawn ownership**. Spawn-per-app-launch (die when the
   last window closes) vs. persistent auto-start service. First
   version: spawn-per-launch; revisit once the monitor/prewarm
   story is concrete (see `tauri-daemon.md` prewarm coordination).
