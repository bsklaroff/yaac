# @yaac/desktop

An Electron shell around the yaac webapp. It has no bundled frontend and no
renderer code. At launch the main process:

1. resolves the selected server from `~/.yaac-client/server.json`;
2. starts its bundled auth daemon (the login broker), best effort;
3. checks that the server answers and will identify this device
   (`GET /api/whoami`);
4. loads the server origin into the window.

From then on the window is a plain browser on that origin. The server
identifies it from each request as it would any browser, so the SPA and its
WebSockets behave exactly as in the webapp. The SPA always comes from the
server it talks to, so the two cannot be on different versions.

A server on this machine is registered in `server.json` like any other
(`yaac server start` registers a host server, `yaac cluster install` the
in-cluster one), so the connect flow has no "local server" case. When no
server is selected or the selected one cannot be reached, the whole window is
the server picker (`src/connect-page.ts`), which shows the error and uses the
same preload bridge as the SPA's Settings → Server section.

**The shell starts and stops this machine's server only when asked**, from
the tray or the picker, by running the `yaac` on PATH
(`src/server-control.ts`). Quitting never stops a server.

## Shell behavior

- **Tray.** Closing the window hides it; the shell stays in the tray (Open,
  a waiting-count line, this machine's servers, Quit). Quit exits the shell
  and its auth daemon; the servers keep running. Reopening (tray click or
  Dock activate) repeats the connect flow, so it notices a server that came
  back. A failed connect does not quit either.
- **This machine's servers.** A Mac can run two installs side by side
  (docs/server-selection.md "Two installs on one machine"): the host server
  and a cluster's. The tray reads `yaac server status --json` and `yaac
  cluster status --json` (every minute and each time its menu opens) and
  shows one action for each install there is. Its lines always say "this
  Mac's", since the window may be on another server:
  - **Start this Mac's server** when the host server is stopped. It runs
    `yaac server start`, which selects that server, and the window lands on
    it. The CLI's refusals show in a dialog.
  - **Stop this Mac's server** when it runs. It runs `yaac server stop`,
    and a window showing that server falls back to the picker.
  - **Restart this Mac's server to update** in place of Stop when the
    server runs a different build than the installed CLI, as after `brew
    upgrade`.
  - **Start / Stop this Mac's cluster server** for a cluster install, by
    `yaac cluster start|stop`. Its server is updated by `yaac cluster
    install`, which rebuilds its image, so the tray names that command
    rather than offering a restart. A `--byo` install's lock is on its
    cluster, so the tray cannot see it and offers no action.

  A window showing a remote server stays on it: a start or restart puts the
  selection the CLI made back the way it was. Each `yaac` run has a timeout
  (15 seconds for a status read, five minutes for an action), so a hung CLI
  shows as a failure rather than wedging the tray or the picker. `yaac` is
  looked up on the login shell's PATH plus Homebrew's bin dirs, in case the
  login shell cannot be read.

  The picker offers a start button for each of those servers that is
  stopped, and after starting the host server it runs `yaac host check` and
  lists any failures, which in practice name the agent CLI to install.
  Stopping or restarting a server never stops an agent: a containerless
  workspace is a tmux server that outlives it, and the next start picks it
  back up.
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
- A registered server: add a remote one in the picker, or, for a server on
  this machine, put `yaac` on PATH (`brew install bsklaroff/yaac/yaac-server`)
  and start it from the picker or the tray (or run `yaac cluster install`
  once for a cluster, after which the tray drives it too). A client of a remote server needs no `yaac` at all.
- The shell adopts the login-shell PATH at startup, because a Finder launch
  gets a minimal PATH and the daemon's children (claude, codex, the
  installers) need the real one. Only PATH is taken from the login shell.

## Run

```sh
pnpm desktop:dev     # bundle the main process with tsup, then launch electron
pnpm desktop:hot     # same, but the window loads Vite for frontend hot reload
pnpm desktop:build   # just the bundle (dist/main.js)
```

All three connect to the same server an installed build would: the selected
entry of `~/.yaac-client/server.json`, and run the same bundled daemon.

The auth daemon (`packages/auth-daemon`) is bundled by tsup as
`dist/auth-daemon.js` and runs in an Electron `utilityProcess`
(`src/server-process.ts`), so it lives exactly as long as the app. It is the
only daemon on the machine: `yaac auth update` signs in in-process and runs
none. Each time the window opens the shell makes sure one runs for the
resolved server, replacing one pointed at a different server. A failed start
never blocks the window; the SPA's sign-in cards then say to use `yaac auth
update`.

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
pnpm desktop:package   # tsup, then electron-builder (unsigned .app in dist-app/)
pnpm desktop:install   # the above, then copy into /Applications
```

The app carries no server and no Node of its own. Everything but
`@lydell/node-pty` is bundled into `dist/`, so node-pty is the package's only
runtime dependency. Its N-API binary loads under Electron's Node without a
rebuild, and it ships outside the asar (`asarUnpack`) because a native module
and node-pty's `spawn-helper` must be real files. A server on this Mac comes
from the `yaac` on PATH.

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
- tray Stop stops the server while a workspace's agent keeps running, and
  tray Start brings the workspace back;
- with a cluster install beside the host server, the tray lists both, and
  each Start and Stop acts on its own;
- after a rebuild or `brew upgrade` of `yaac`, the tray offers **Restart
  server to update** within a minute, and afterwards says "Server running";
- window bounds survive a relaunch.

The picker:

- `yaac server stop`, relaunch: "Could not connect to http://127.0.0.1:…"
  above a row for that origin and **Start a server on this Mac**. Click it:
  the app loads, and the tray says "Server running".
- `yaac remote off`, relaunch: "No yaac server selected", with the saved rows
  still listed.
- Add an origin that does not answer: the error shows inline and the picker
  stays.

`test-playwright-scripts/desktop-server-picker.js` drives these against a real
Electron build.

The auth daemon:

- After launch, `GET /api/auth/agent` on the server answers
  `{"connected":true}`, and after Quit `false`.
- Switching servers in the picker moves it to the new one.
- For the packaged app, launch from Finder and complete a Claude and a Codex
  sign-in from the SPA cards. Success shows the daemon found the CLIs on the
  login-shell PATH.

`test-playwright-scripts/desktop-auth-daemon.js` checks the first point and a
stubbed sign-in under node-pty, against a dev or a packaged build.
