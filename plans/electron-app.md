# yaac desktop — an Electron shell over the daemon

## Goal

Make yaac a double-click desktop app: open it and use it, with no CLI
step and no bootstrap-code pasting, while the daemon, webapp, and CLI
stay exactly as they are and yaac remains fully developable inside yaac.

The app is deliberately thin. It is a native **shell** around the
existing webapp plus the OS-level affordances a browser tab can't do —
background attention signals (notifications, tray, dock badge) and
one-click lifecycle. It is **not** a rewrite and it does not absorb the
backend: the daemon keeps running as its own standalone Node process,
and the React SPA is loaded verbatim.

## The load-bearing decisions

Everything below follows from five choices. They are what keep the app
thin, keep the daemon identical whether launched by the CLI or the app,
and keep nested development working.

1. **Electron owns only the window + tray + notifications + daemon
   supervision.** No business logic lives in the Electron layer.

2. **The daemon stays a standalone Node child process**, spawned the same
   way the CLI spawns it today (`src/daemon/cli.ts:526` `spawnDaemonDetached`).
   It is never run inside Electron's main process. Consequences:
   - `@lydell/node-pty` (native) stays on the standard Node ABI — no
     `electron-rebuild`, no ABI coupling.
   - The daemon has zero dependency on Electron and runs headless
     identically in a terminal, a test, a nested container, or under the
     app.

3. **The webapp is loaded by URL, unchanged.** Electron points a
   `BrowserWindow` at the real daemon origin
   (`http://127.0.0.1:<port>/`). The SPA already talks to its own origin
   — `fetch(path, {credentials:'same-origin'})` (`src/frontend/lib/apiClient.ts`,
   `createSession.ts`) and `new WebSocket(``${host}/events``)`
   (`src/frontend/lib/useEvents.ts:27`). Loading the daemon origin makes
   all of that work with **no frontend edits**. Loading from `file://`
   would force cross-origin fetch/WS and loopback-cookie pain for no
   benefit.

4. **The auth handshake is reused, just driven by the app instead of a
   human.** This is exactly `yaac open` (`src/daemon/cli.ts:486`
   `openWebapp`) internalized: main reads the lock
   (`src/shared/lock.ts`), which holds the bearer secret, GETs
   `/auth/bootstrap-code`, and loads `…/?bootstrap=<code>`. The SPA does
   its existing exchange for the HttpOnly cookie
   (`src/frontend/lib/bootstrap.ts`). Invisible to the user.

5. **The CLI is retained and is load-bearing — it cannot be removed.**
   When you run yaac-in-yaac, the inner yaac lives in a headless
   container with no display; it is inherently CLI/daemon-driven. Electron
   is strictly the host-side human UI. So the CLI isn't kept "for some
   people" — nested development depends on it. You personally never touch
   it.

## Architecture

```
┌─ Electron main (supervisor) ──────────────────────────┐
│  • hydrate PATH / shell env                            │
│  • ensure daemon (reuse start/restart logic)           │
│  • fetch bootstrap code via bearer                     │
│  • tray + dock badge + OS notifications                │
│  • subscribe to /events for background attention       │
│                                                        │
│   spawns (detached, real Node runtime)                 │
│        │                                               │
│        ▼                                               │
│   yaac daemon  ◄── standalone Node process, unchanged  │
│   (127.0.0.1:<port>, k8s Jobs, podman builds, PTY)     │
│        ▲                                               │
│        │ http + ws (same-origin, cookie auth)          │
│   ┌────┴───────────────────────────────┐              │
│   │ BrowserWindow (renderer)           │              │
│   │  = the existing built SPA,         │              │
│   │    loaded at http://127.0.0.1:port │              │
│   └────────────────────────────────────┘              │
└────────────────────────────────────────────────────────┘
```

Three processes:

- **Main** — Electron's Node process. Lifecycle, tray, notifications,
  window, env hydration, daemon supervision, auto-auth. Keep it thin; all
  real logic lives in plain, unit-testable modules it calls into.
- **Renderer** — the existing SPA, served by the daemon, loaded by URL. A
  plain web client, same as in a browser. **No `preload` bridge in v1** —
  the renderer needs no privileged native API to do its job. (A tiny
  preload can come later if we want native menu/deep-link hooks.)
- **Daemon child** — unchanged; see decision 2.

## Startup sequence (main process)

1. **Hydrate the environment.** An Electron app launched from Finder
   inherits a minimal `PATH`, not your login shell's. The daemon shells
   out to `kubectl`, `podman`, `kind`, `tmux`, and `brew` — all of which
   would be missing. Resolve the login shell env (spawn a login shell, or
   a `shell-env`-style helper) and pass it to the daemon child. This is
   the single most common "works in dev, breaks in the packaged app"
   gotcha; do it first. (The CLI dodges it because it already runs with a
   full terminal `PATH`; `spawnDaemonDetached` forwards `process.env` —
   `src/daemon/cli.ts:532`.)

2. **Ensure the daemon.** Read the lock (`src/shared/lock.ts:readLock`).
   Live and buildId matches → reuse. Live but outdated buildId → restart.
   Absent/stale → start. This is the exact logic in `startDaemon`
   (`src/daemon/cli.ts:379`); reuse it, with the runtime caveat in
   Packaging below.

3. **Preflight the cluster.** Call `runClusterCheck()`
   (`src/lib/k8s/cluster-check.ts`, already a pure `{ok, results}`
   function — no CLI shelling). Green → continue. Not green → the setup
   flow (below).

4. **Auto-auth.** GET `/auth/bootstrap-code` with the bearer → `code`.

5. **Open the window.** `BrowserWindow.loadURL(http://127.0.0.1:<port>/?bootstrap=<code>)`.

6. **Subscribe to `/events`** from main (bearer or the same cookie) so
   attention signals fire even when the window is closed — the whole
   reason for going native.

## Lifecycle & tray (persistent background service)

Modeled on Docker Desktop: the app can be "closed" but still nudging you.

- **Window close ≠ quit.** Closing hides the window; the daemon keeps
  running; the tray stays.
- **Tray menu:** Open yaac · (waiting sessions, if any) · Quit yaac.
- **Dock badge** = number of sessions awaiting input, derived from the
  `/events` snapshot (the "waiting" attention state already exists —
  `src/daemon/status-watcher.ts`, surfaced on the rail today).
- **Notifications** fire from main on transitions into "waiting"
  (`next waiting →`), so you get pulled back without the window open.
- **Explicit Quit** stops the daemon (`stopDaemon`, `src/daemon/cli.ts:418`).
  Note: agent sessions are Kubernetes Jobs, so they **survive** the daemon
  exiting — they just stop being watched. Re-opening the app resumes
  watching. (A future "quit but keep nudging" is possible but out of
  scope; Quit = stop.)

## First-run setup (auto-run, streamed progress, no wizard)

No graphical wizard. If the machine isn't ready, run the commands and
show a live progress log + bar.

The daemon starts fine without a cluster — its cluster bootstrap is
best-effort and non-fatal (`src/daemon/cli.ts:310`) — so it can serve the
SPA and drive setup even on a blank machine. That lets us keep Electron
out of the setup UI entirely:

- On launch, `runClusterCheck()`. Green → straight into the app.
- Not green → the SPA shows a **"cluster not ready → set up"** screen,
  driven by a **new streaming daemon endpoint** that runs the existing
  setup logic and streams output (same pattern as session-create and the
  live build-progress UI). Two tiers:
  - **Binaries** (podman / kind / kubectl / cilium): detect what's
    missing, run the install commands, stream output. A step that needs
    `sudo` or interaction **pauses** the progress screen with a clear
    "this step needs your OK, here's the command" rather than failing
    silently. On your Mac this is mostly a non-issue (`brew` is
    user-level, `podman machine` needs no sudo); on Linux, rootful podman
    needs elevation (the recent Cilium fix), so that's where the pause
    matters.
  - **Cluster wiring** (`yaac cluster setup`, `src/commands/cluster-setup.ts`):
    create the cluster, install Cilium, stand up the registry + proxy —
    streamed.
- Re-run `runClusterCheck()` → on green, drop into the app.

Why a daemon endpoint rather than Electron shelling the commands: it keeps
Electron thin, it's headless-testable, and the CLI and app share one
implementation — the same "lift the command's logic behind a route" arc
the rest of the daemon already followed. Electron's only setup role is to
make sure the daemon is up; the SPA owns the not-ready UX.

## Packaging & runtime

- **Bundler:** `electron-builder` (mac `.dmg` first). Chosen over
  electron-forge for its mature signing/notarization/auto-update path.
- **Ship a standalone Node runtime and spawn the daemon with it.** Inside
  Electron, `process.execPath` is the Electron binary, not node — so the
  CLI's `spawn(process.execPath, [cli, 'daemon', 'run'])`
  (`src/daemon/cli.ts:555` `resolveDaemonInvocation`) would relaunch
  Electron. The clean fix is to bundle a real Node binary and point the
  daemon spawn at it. This keeps node-pty on the standard ABI and the
  daemon byte-for-byte identical to a CLI launch (decision 2).
  - *Alternative considered:* spawn with `ELECTRON_RUN_AS_NODE=1` (reuse
    Electron's Node) and `electron-rebuild` node-pty for Electron's ABI.
    Rejected for v1 — it recouples the daemon's native module to Electron
    and breaks the "identical to CLI" property. Costs ~a Node binary
    (~50MB) in app size; worth it.
- **App contents:** electron main + the existing `dist/` bundle
  (`dist/cli.js`, `dist/frontend`, `dockerfiles`, `k8s`) + the Node
  runtime. `PACKAGE_ROOT` already keys off a `bundled` flag
  (`src/shared/paths.ts:23`), so static-asset resolution has a hook.
- **External tooling is not bundled.** podman/kind/kubectl/cilium remain
  host installs (handled by the setup flow). The app is a UI + supervisor,
  not a container runtime.
- **Signing / notarization:** wire the config now; a properly
  Developer-ID-signed + notarized release is a **fast-follow**. For your
  own and small-team use in the interim, an ad-hoc build with a documented
  right-click-Open is fine.
- **Auto-update:** `electron-updater`, **fast-follow** once signing
  exists. Not in v1.
- **Platforms:** macOS first (you're on darwin). Linux AppImage later;
  Windows is out of scope (the daemon path is unix-y).

## Dev workflow & staying developable in yaac

Same repo — there's already a pnpm workspace. New `src/electron/`
(`main.ts`, later `preload.ts`). Add `electron` and `electron-builder` as
exact-version dev deps (`pnpm add -DE`, per repo rule).

- **Dev loop:** the SPA already runs under Vite on `:1420` and proxies
  `/auth`, `/events`, `/pty`, `/session`, … to the daemon
  (`vite.config.ts:42`). So `pnpm electron:dev` = Vite dev server + the
  daemon + Electron main pointed at `http://localhost:1420`. The bootstrap
  handshake works unchanged because `/auth` is proxied. Recommend
  `electron-vite` (or a second tsup target) so main/preload share the TS
  setup.
- **Dev-instance isolation (this is what protects dev-in-yaac).** A dev
  build must not fight the installed app's singleton daemon. Both the lock
  and port are env-overridable: `YAAC_DATA_DIR` relocates the lock + data
  (`src/shared/paths.ts:getDataDir`), `YAAC_DAEMON_PORT` moves the port
  (default 8787, `src/shared/daemon-port-default.ts`). A dev instance sets
  both, plus a distinct Electron `userData` dir and app name/icon, so your
  everyday app and a dev build **run side by side**. That coexistence is
  precisely what lets you develop the Electron app itself while your
  normal one keeps working.
- **What "developable in yaac" actually means here.** ~95% of the app is
  untouched by this: the daemon, webapp, CLI, and k8s code all still
  build, typecheck, lint, unit-test, and run headless in a container. An
  agent in a yaac session can do all of that on the Electron code too —
  edit main/preload, `pnpm lint`, `pnpm test:unit`. The one unavoidable
  limit is narrow: **an Electron window needs a display to render**, and a
  session is a headless container. So an agent can *write and verify the
  logic* of the shell, but *seeing the window / tray / a real
  notification* happens on your Mac, outside a session. That's true of any
  GUI app. The mitigation is the design rule: keep main thin, push
  supervisor / auth / env-hydration / setup-orchestration logic into plain
  modules that unit-test headlessly. Nested yaac never runs Electron at
  all.

## Testing

- **Unit** (`test/unit/`, per repo rule "every exported function has a
  unit test"): the extracted main-process logic — the supervisor decision
  (reuse / restart / start from a lock + buildId), the bootstrap-code
  fetch, env hydration, and cluster-check gating. All pure, all headless.
- **App-shell e2e:** Playwright's `_electron` API (needs a display; Xvfb
  on CI), smoke level — launch app → daemon comes up → window loads →
  authed. This is separate from the cluster-backed vitest e2e suite and
  from the headless unit tests. Per repo convention, hand-driven
  browser/Electron scripts live in `test-playwright-scripts/` with a
  header comment saying what they verify and how to run them.
- The daemon setup endpoint gets normal daemon route coverage.

## What changes in existing code

Small, and mostly additive:

- **Webapp:** nothing required for v1 (loaded by URL). The setup screen
  (Phase 2) is a new SPA route.
- **Daemon:** add one streaming setup endpoint that lifts the existing
  `cluster setup` logic behind a route (recommended; otherwise Electron
  shells the CLI, which is thicker).
- **Shared supervision:** `startDaemon` / `openWebapp` are already
  import-friendly; the only new wrinkle is parameterizing the daemon's
  node binary + env for the Electron-as-node caveat (Packaging). Factor
  that so the CLI and Electron share it.

## Deferred decisions

- Signing identity and notarization timing.
- Auto-update channel and release hosting.
- Linux packaging.
- Whether a future Quit offers "keep nudging in the background" vs. today's
  Quit = stop the daemon.

## Phased delivery

- **Phase 0 — spike.** Bare Electron main: hydrate PATH, spawn the daemon
  under a real Node runtime, auto-auth, load the window. Prove the whole
  loop end-to-end on your Mac.
- **Phase 1 — the shell.** Tray, window-close-to-tray, dock badge from
  `/events`, notifications on "waiting".
- **Phase 2 — first-run setup.** Streaming daemon setup endpoint + SPA
  setup screen + cluster-check gating; auto-run installs and wiring with a
  live progress log.
- **Phase 3 — packaging.** electron-builder, bundled Node, `.dmg`;
  dev-instance isolation and `pnpm electron:dev`.
- **Phase 4 — distribution (fast-follow).** Signing, notarization,
  auto-update.
