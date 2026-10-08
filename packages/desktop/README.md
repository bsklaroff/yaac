# @yaac/desktop

An Electron shell around the yaac webapp. It has no bundled frontend and no
renderer code. At launch the main process:

1. resolves the selected server from `~/.yaac-client/server.json`;
2. starts the machine-local auth daemon (the login broker), best effort;
3. checks that the server answers and will identify this device
   (`GET /api/whoami`);
4. loads the server origin into the window.

From then on the window is a plain browser on that origin. The server
identifies it from each request as it would any browser, so the SPA and its
WebSockets behave exactly as in the webapp. The SPA always comes from the
server it talks to, so the two cannot be on different versions.

**The shell never starts a server.** A server on this machine is registered in
`server.json` like any other (`yaac server start` registers a host server,
`yaac cluster install` the in-cluster one), so the shell has no "local
server" case. When no server is selected or the selected one cannot be
reached, the whole window is the server picker (`src/connect-page.ts`), which
shows the error and uses the same preload bridge as the SPA's Settings →
Server section.

## Shell behavior

- **Tray.** Closing the window hides it; the shell stays in the tray (Open,
  a waiting-count line, Quit). Quit exits the shell only; the server keeps
  running. Reopening (tray click or Dock activate) repeats the connect flow,
  so it notices a server that came back. A failed connect does not quit
  either, so the user can go start a server.
- **Attention signals.** The main process follows the server's `/api/events`
  WebSocket, re-resolving the server on every reconnect so it follows a
  change of selection. Workspaces waiting for input show as a dock badge, the
  tray line, and one OS notification each time a workspace starts waiting
  (`waitingSinceMs`). A reconnect or the first snapshot after launch does not
  re-notify.
- **Port forwarding.** The shell binds each workspace's forwarded ports on
  this machine's loopback and tunnels connections to the server, from the
  same `/api/events` stream (`src/forwarder.ts`,
  [docs/port-forward-tunnel.md](../../docs/port-forward-tunnel.md)). It binds
  loopback only; to expose ports to other machines use
  `yaac forward --bind`. It binds nothing against a containerless server on
  this machine, whose workspaces already hold their ports.
- **Window chrome.** The title bar and native traffic lights are hidden
  (`titleBarStyle: 'hidden'`); the SPA draws its own window controls
  (`WindowControls.tsx`) and marks `titlebar-drag` strips so the window can
  still be moved. The native background follows the SPA's `--color-shell`
  for the OS appearance (`src/theme-bg.ts`). Window bounds persist across
  launches and are restored only if still on a display
  (`src/window-state.ts`). The role-based menu keeps Cmd-C/V working in the
  xterm terminals, and links open in the system browser.

## Prerequisites

- The repo's usual `pnpm install` (the `electron` dev dependency downloads
  its binary).
- A registered server: run `yaac server start` or `yaac cluster install`
  once, or add one in the picker.
- For dev runs, the `yaac` CLI on PATH, to start the auth daemon. The
  packaged app runs its bundled Node and CLI instead, and resolves the
  login-shell PATH at startup, because a Finder launch gets a minimal PATH and
  the daemon's children (claude, codex, npm, brew) need the real one. Only
  PATH is taken from the login shell.

## Run

```sh
pnpm desktop:dev     # bundle the main process with tsup, then launch electron
pnpm desktop:hot     # same, but the window loads Vite for frontend hot reload
pnpm desktop:build   # just the bundle (dist/main.js)
```

All three connect to the same server an installed build would: the selected
entry of `~/.yaac-client/server.json`. A dev run differs from the installed app
only in running `yaac` from PATH.

Each time the window opens, the shell calls `ensureAuthDaemonSpawned` for the
resolved server, sharing `~/.yaac-client/.auth-daemon.lock` with the CLI. So
there is never a second daemon, and a daemon pointed at a different server is
restarted. A failed spawn never blocks the window; the SPA's sign-in cards
still say what to run by hand.

`desktop:dev` loads the SPA the server serves, so frontend edits need a
rebuild. `desktop:hot` (`scripts/dev-hot.sh`) starts the server if needed
(Vite's proxy finds it through `server.json`), starts Vite on `:1420`, and
launches Electron with `YAAC_DESKTOP_RENDERER_URL=http://localhost:1420/`.
Only the renderer hot-reloads; main-process changes (`src/*.ts`) need a
restart.

`YAAC_DESKTOP_RENDERER_URL` changes only which origin the window loads, never
which server is probed. With it set, the SPA loads from Vite, and its
relative `/api/...` requests (HTTP and WebSocket) go to Vite, whose proxy
forwards them to the selected server. That is the same setup as
`pnpm frontend:dev` in a browser at `http://localhost:1420/`. No credential is
involved in either mode: the server treats a request at its loopback as this
machine's owner, and one through `tailscale serve` as the tailnet user it
names.

The desktop app is not part of `pnpm build` and is not in the npm package.

## Packaging (macOS)

```sh
pnpm desktop:package   # root pnpm build, tsup, stage, electron-builder (unsigned .app in dist-app/)
pnpm desktop:install   # the above, then copy into /Applications
```

`scripts/stage-server.ts` stages the bundled server from the real publish
artifact: `pnpm pack` at the repo root (which turns `catalog:` pins into
versions), untarred to `staging/server`, then `npm install --omit=dev`. There
is no hand-kept dependency list; the root manifest is the contract, checked at
build time by `scripts/check-cli-externals.ts`. A standalone Node
(`staging/node/node`, copied from the build machine) ships alongside, so
`@lydell/node-pty` gets a matching Node ABI without Node on the target.

`scripts/after-pack.cjs` copies both into `yaac.app/Contents/Resources`
(electron-builder's `extraResources` strips `node_modules`).
`scripts/install-app.ts` installs with `ditto`, because a copy that follows
symlinks breaks the Electron framework's `Versions/Current` links and
crashes the GPU process at launch. The app is unsigned and not notarized.

## Known limitations

- The app can add and switch servers but not forget one; `yaac remote unset`
  forgets them all.
- The SPA's manual Light/Dark override recolors the page but not the native
  window background. The default System theme is correct.

## Verifying by hand

| | server on this machine | server elsewhere |
|---|---|---|
| webapp | `yaac server start`, then open the origin `yaac remote status` shows | `yaac remote set <url>`, then open that origin from a tailnet device logged in as a user |
| desktop | `yaac server start`, then `pnpm desktop:dev` lands on the loopback origin with no interaction | `yaac remote set …`, then it lands on `https://…`; from a tagged device it lands on the picker showing the server's refusal |

Also check in the desktop app:

- a terminal attaches, and Cmd-C/V work in it;
- holding k in vim in a terminal pane repeats the key with no accent popup,
  from the first launch;
- a forwarded-port link opens in the system browser;
- close hides to the tray, and tray Open brings the window back;
- a waiting workspace badges the dock and notifies once, and clicking the
  notification focuses the window;
- Quit leaves the server running;
- window bounds survive a relaunch.

The picker:

- `yaac server stop`, relaunch: "Could not connect to http://127.0.0.1:…"
  above a row for that origin. Start the server and click Connect: the app
  loads.
- `yaac remote off`, relaunch: "No yaac server selected", with the saved rows
  still listed.
- Add an origin that does not answer: the error shows inline and the picker
  stays.

`test-playwright-scripts/desktop-server-picker.js` drives these against a real
Electron build.

The auth daemon:

- After launch, `yaac auth server status` shows running and connected, and
  its `target:` line names the selected server.
- Quit leaves it running, and a relaunch starts no second one.
- Switching servers and relaunching restarts it against the new one.
- For the packaged app, launch from Finder and complete a Claude sign-in from
  the SPA card. Success shows the daemon found `claude` on the login-shell
  PATH.
