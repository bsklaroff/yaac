# @yaac/desktop

An Electron shell around the yaac webapp. There is no bundled frontend and no
renderer code: the main process resolves the target server (enabled
`~/.yaac/remote.json`, else the local `~/.yaac/.server.lock` — without the
CLI's build-id match, since the shell ships no server code to match), spawns
`yaac server start` when the local daemon is down, ensures the machine-local
auth-daemon (login broker) best-effort like `yaac open` does, mints a one-time
exchange token (POST /tokens — the same endpoint `yaac open` uses, via the
shared typed client), and loads `<server-origin>/?token=…` into the window. From
then on the window is a plain browser on the server origin, so the SPA,
cookie auth, and WebSockets behave exactly like the webapp, and version skew
is impossible (the SPA comes from the server it talks to).

## Shell behavior

- **Tray, not quit-on-close.** Closing the window hides it; the shell lives
  in the tray (Open / waiting-count status / Quit). Quit quits the *shell*
  only — the server keeps running; it was never ours to stop. Reopening
  (tray click, Dock activate) reruns the resolve→mint flow: the exchange
  token is single-use, and rerunning also revives a local server that died
  while the shell sat in the tray.
- **Attention signals.** The main process follows the server's `/events`
  WebSocket as a bearer client (re-resolving the target on every reconnect,
  so a restarted server's rotated port/secret self-heals) and surfaces
  waiting sessions as a macOS dock badge, the tray status line, and one OS
  notification per new waiting *spell* (`waitingSinceMs` — a session that
  waits anew re-notifies; an ongoing wait doesn't, and neither does a
  reconnect or the first snapshot after launch).
- **Native chrome.** `hiddenInset` title bar: the floating traffic lights sit
  over the SPA's top row, which reserves `titlebar-drag` regions for them
  (see the frontend's `App.tsx`/`Sidebar.tsx`/`ProjectRail.tsx`). The
  window's native background mirrors the SPA's `--color-base` per OS
  appearance (`src/theme-bg.ts`); bounds persist across launches and are
  restored only while still on some display (`src/window-state.ts`); the
  role-based menu keeps Cmd-C/V working inside the xterm terminals.

## Prerequisites

- Nothing beyond the repo's usual `pnpm install` (the `electron` dev
  dependency downloads its prebuilt binary on install).
- For dev runs: the `yaac` CLI on PATH for local-server auto-start and the
  auth-daemon spawn. GUI launches with a minimal PATH self-heal: on ENOENT
  the server spawn retries once with the login shell's PATH
  (`src/server-process.ts`). The packaged app instead runs its bundled Node +
  CLI and resolves the login-shell PATH up front (the *children* need it from
  a Finder launch — kubectl/podman/tmux for the server, claude/codex/npm/brew
  for the auth-daemon). Only PATH is hydrated — other shell-profile env vars
  don't reach a packaged server.

## Run

```sh
pnpm desktop:dev     # tsup-bundle the main process, then electron .
pnpm desktop:hot     # same, but the window loads Vite for frontend hot-reload
pnpm desktop:build   # just the bundle (dist/main.js)
```

All of these share one data dir and one server: the boot flow resolves the
same target an installed build would (enabled `~/.yaac/remote.json`, else the
local `~/.yaac/.server.lock`), starting a local server if none is up. A dev
run differs from the installed app only in spawning `yaac` from PATH rather
than the bundled Node.

Each window open also fires a best-effort `ensureAuthDaemonSpawned` against
the resolved target (local or remote — the broker is machine-scoped), sharing
`~/.yaac/.auth-daemon.lock` with the CLI: no double daemon next to `yaac
open`, and a daemon pointed at a stale target (the remote setting flipped) is
restarted. Fire-and-forget — a failed spawn never blocks or fails the window;
the SPA's sign-in cards still say what to run by hand.

**`desktop:dev`** loads the SPA the resolved server serves, so frontend edits
need a rebuild. **`desktop:hot`** (`scripts/dev-hot.sh`) instead points the
window at the Vite dev server for live frontend HMR: it ensures the shared
server is up (so Vite reads its real port from the lock), starts Vite on
`:1420`, then launches Electron with
`YAAC_DESKTOP_RENDERER_URL=http://localhost:1420/`. Only the *renderer*
hot-reloads — main-process (`src/*.ts`) changes still need a restart.

### How the boot flow authenticates (both modes)

`src/flow.ts` always resolves the real server target and mints a one-time
exchange token against it (`POST /tokens`, the same call `yaac open` makes);
`YAAC_DESKTOP_RENDERER_URL` never changes *which* server is minted against,
only the origin the window then loads. The window opens `<base>/?token=…`, and
the SPA (`App.tsx`) trades that token for an HttpOnly session cookie at
`POST /auth/web-session`, then scrubs it from the URL.

- **`desktop:dev` / installed:** `<base>` is the server origin, so the exchange
  and every later API/WS call are same-origin to the server directly.
- **`desktop:hot`:** `<base>` is `http://localhost:1420`, so the SPA loads from
  Vite. The exchange and all API/WS calls are relative (`/auth/web-session`,
  `/session`, `/events`, `/pty`), so they hit Vite same-origin and its proxy
  forwards them to the server it read from the lock — the cookie lands on the
  `localhost:1420` origin, exactly like the browser `pnpm frontend:dev` flow.

Plain `pnpm frontend:dev` (browser, no shell) is the same picture minus the
mint step: open `http://localhost:1420/` and, with no `?token=` in the URL, the
SPA falls through to the sign-in splash — paste a token from `yaac auth token
create`, or open the Vite URL with a `?token=` you minted yourself.

The desktop app is not part of `pnpm build`; the published npm artifact never
includes it.

## Packaging (macOS)

```sh
pnpm desktop:package   # root pnpm build → tsup → stage → electron-builder (unsigned .app in dist-app/)
pnpm desktop:install   # the above, then ditto into /Applications
```

The bundled server is staged from the REAL publish artifact
(`scripts/stage-server.ts`): `pnpm pack` at the repo root — which rewrites
`catalog:` pins into concrete versions — untarred to `staging/server` and
`npm install --omit=dev`ed in place. There is no hand-maintained dependency
list; the contract is the root manifest, enforced at build time by
`scripts/check-cli-externals.ts`. A standalone Node (`staging/node/node`, a
copy of the staging machine's binary) rides along so `@lydell/node-pty` gets
a real Node ABI with no Node install on the target machine.
`scripts/after-pack.cjs` copies both into `yaac.app/Contents/Resources`
(electron-builder's extraResources strips node_modules), and
`scripts/install-app.ts` installs with `ditto` — a dereferencing copy breaks
the Electron framework's `Versions/Current` symlinks and crashes the GPU
process on launch. Signing, notarization, and a `.dmg` are a fast-follow.

First run on a fresh machine: the SPA's cluster gate (`GET /cluster/check`)
notices there is no cluster and offers setup, streaming
`POST /cluster/setup` progress — no terminal needed.

## v1 limitations (accepted)

- Switching local↔remote means flipping `yaac remote on|off` and relaunching
  the app; an in-app picker is deferred.
- A renderer-side manual Light/Dark override recolors the page but not the
  native window backing (main isn't told); the default System theme stays
  correct.

## Verifying the 2×2 by hand

| | local server | remote server |
|---|---|---|
| webapp | `yaac open` | `yaac remote set <url> --token <t>` + `yaac open` |
| desktop | remote off, server stopped → `pnpm desktop:dev` should start the server and land authed on the loopback origin | remote on → should land on `https://…`; break the token to see the error dialog |

Also check from the desktop app: a terminal attaches (PTY WebSocket) and
Cmd-C/V copy/paste inside it; a forwarded-port link opens in the system
browser (`setWindowOpenHandler` in `src/main.ts`); close hides to the tray
and tray-Open lands authed again (fresh mint); a waiting session badges the
dock and notifies once, and clicking the notification focuses the window;
Quit leaves `yaac server status` running; window bounds survive a relaunch;
the error dialogs: `yaac` off PATH → "yaac CLI not found"; stopped remote →
"Could not connect to the remote server".

And the auth-daemon: after launch, `yaac auth server status` shows running +
connected (with `target: https://…` when remote is on); Quit leaves it
running, and a relaunch spawns no second one (lock idempotency); flipping
`yaac remote on|off` + relaunch repoints it (baseUrl-mismatch restart). For
the packaged app, launch from Finder (minimal PATH) and drive a Claude
sign-in from the SPA card — success proves the daemon found `claude` via the
hydrated login-shell PATH.
