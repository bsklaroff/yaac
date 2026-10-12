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
in-cluster one), so the connect flow has no "local server" case. Servers
are chosen on the shell's own **Servers page** (`src/servers-page.ts`,
docs/server-selection.md "The desktop shell"). When no server is selected
or the selected one cannot be reached, the whole window is that page,
showing the error. The SPA's Servers button (in the rail, above Settings),
its server badge and the tray's **Servers…** open it over the server's page,
with Back to return. It lists the saved servers (Connect, Remove, and
"(stopped)" or "(refused)" beside any that does not answer or will not
identify this device), adds one by origin, and
lists this Mac's installs. While Tailscale seems not to be running, a banner
says so, and a remote server that does not answer names Tailscale as the cause.

**The shell sets up, starts and stops this machine's servers only when
asked**, from the tray or the Servers page, by running `brew` and the
`yaac` on PATH (`src/local-setup.ts`, `src/server-control.ts`). Quitting
never stops a server.

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
  shows one action for each install there is. It names them as the
  Servers page does, **Local containerless server** and **Local Kubernetes
  cluster**, each with its origin in parentheses once it has registered
  one (`installLabel`):
  - **Start local containerless server** when the host server is stopped.
    It runs `yaac server start`, which selects that server, and the window
    lands on it. The CLI's refusals show in a dialog.
  - **Stop local containerless server** when it runs. It runs `yaac server
    stop`; if that was the selected server the window is disconnected and
    shows the Servers page.
  - **Restart local containerless server to update** in place of Stop when
    the server runs a different build than the installed CLI, as after
    `brew upgrade`.
  - **Start / Stop local Kubernetes cluster** for a cluster install, by
    `yaac cluster start|stop`. Its server is updated by `yaac cluster
    install`, which rebuilds its image, so the tray names that command
    rather than offering a restart. A `--byo` install's lock is on its
    cluster, so the tray cannot see it and offers no action.
  - **Set up a local containerless server / Kubernetes cluster…** for an install this Mac
    does not have yet, and both when there is no `yaac` at all. It opens
    the Servers page with that setup unfolded (below). While a setup runs,
    the tray shows its current step.

  A window showing a remote server stays on it: a start or restart puts the
  selection the CLI made back the way it was. Each `yaac` run has a timeout
  (15 seconds for a status read, five minutes for an action), so a hung CLI
  shows as a failure rather than wedging the tray or the page. `yaac` is
  looked up on the login shell's PATH plus Homebrew's bin dirs, in case the
  login shell cannot be read.

  On the Servers page each install is a row of the server list, by the
  same name and origin, with its state and a Start or Stop, the selected
  one included; an install this Mac lacks is offered for setup below the
  list instead. After starting the host server the shell runs `yaac host
  check` and lists any failures, which in practice name the agent CLI to
  install. A start, like a setup, lands the window on the server it
  selects. Stopping the selected server disconnects the window; any other
  stop renders the page again. The selected row also has **Disconnect**,
  which deselects it as `yaac remote disconnect` does, leaving the window on the
  Servers page with nothing selected.
- **Setup.** With no `yaac` CLI, or with one but no install and no server
  selected, the Servers page leads with the two kinds of install, unfolded
  (`src/servers-page.ts`): **Local containerless server**, with no sandbox,
  so an agent reaches everything your account can (listed in the same
  words as the SPA's containerless badge, from `@yaac/shared/setup-copy`),
  and **Local Kubernetes cluster** (kind), gVisor-sandboxed pods behind
  the egress proxy, which needs a podman VM, several GB of disk and memory,
  and an Apple silicon Mac (it is disabled elsewhere). Each shows its
  commands to copy, says which Homebrew taps it trusts (`libkrun/krun` is
  a third party's), and has a button that runs them in the background
  (`src/local-setup.ts`):

  | Containerless | Cluster |
  |---|---|
  | `brew trust bsklaroff/yaac` | `brew trust bsklaroff/yaac` |
  | `brew install bsklaroff/yaac/yaac-server` | `brew install bsklaroff/yaac/yaac-server` |
  | `yaac server start` | `brew trust libkrun/krun` |
  | `yaac host check` | `brew tap libkrun/krun` |
  | | `brew install bsklaroff/yaac/yaac-cluster` |
  | | `yaac cluster install` |

  Each Homebrew step first checks whether it is already done (the formula
  installed or `yaac` already on PATH, the tap trusted or added) and skips
  itself, so only the missing work runs and a source-built `yaac` needs no
  Homebrew for the containerless setup. `yaac cluster install` always
  runs, since it converges whatever an interrupted install left. The shell
  never installs Homebrew: without it the setup says so and links
  https://brew.sh.

  A run lives in the main process, so it survives the window moving
  between the Servers page, the SPA and a reload; the page polls it for its
  steps and the last lines of output, and can cancel it,
  which kills the command's whole process group. Only one setup or server
  action runs at a time. A brew install or `yaac cluster install` may take
  up to 90 minutes before it is timed out. Quit during a run asks first,
  then cancels it, rather than leaving its commands running unread. A setup
  that has not succeeded is remembered across launches (in the app's
  `unfinished-setups.json`), so a half-made install, such as a cluster
  whose driver is recorded but whose server was never deployed, is offered
  for setup again instead of showing as a stopped server. A setup ends
  with its new server selected (`yaac server start` selects; a first
  `yaac cluster install` does too), and the window lands on it, with the
  host check's failures in a dialog as after a start.

  **Who may run one.** The renderer only ever names a setup by scope
  (`'server'` or `'cluster'`), and asks for state or a cancel; the
  commands are a fixed table in the main process, which validates every
  IPC payload. Every server call (switch, add, remove, setup, start, stop,
  cancel, state) is accepted only from the main window's top frame showing
  a `data:` page, which only the shell loads: the window follows no
  navigation its page starts to another origin. A server's page can only
  ask for the Servers page to be shown. Before a setup runs, the main process shows a native
  confirmation listing its commands and the taps it trusts, with Cancel as
  the default, which no page can answer.
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
- A registered server: add a remote one on the Servers page, or set one up
  on this machine from that page or the tray (or from a terminal with the
  same commands). A client of a remote server needs no `yaac` at all.
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

- The SPA's manual Light/Dark override recolors the page but not the native
  window background. The default System theme is correct.

## Verifying by hand

| | server on this machine | server elsewhere |
|---|---|---|
| webapp | `yaac server start`, then open the origin `yaac remote list` marks | `yaac remote add <url>`, then open that origin from a tailnet device logged in as a user |
| desktop | `yaac server start`, then `pnpm desktop:dev` lands on the loopback origin with no interaction | `yaac remote add …`, then it lands on `https://…`; from a tagged device it lands on the Servers page showing the server's refusal |

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

The Servers page:

- With no `yaac` on PATH, launch: both setups, each with its commands and
  **Run them for me**. Run the containerless one: a native confirmation
  names the commands and the taps, the steps tick off, the log tail
  follows the brew output, and the window lands on the new server. Cancel
  a cluster setup during `brew install` and check that brew stops; quit
  during `yaac cluster install`, and check that relaunching offers the
  cluster setup again.

- `yaac server stop`, relaunch: "Could not connect to http://127.0.0.1:…"
  above a row for that origin and **Start a server on this Mac**. Click it:
  the app loads, and the tray says "Server running".
- `yaac remote disconnect`, relaunch: "No yaac server selected", with the saved rows
  still listed.
- Add an origin that does not answer: the error shows inline and the page
  stays. A saved origin whose server is down shows "(stopped)".
- With a remote server saved, stop Tailscale and open the page: a banner
  says Tailscale does not seem to be running, and Connect on the remote
  row fails naming Tailscale; start Tailscale and open the page again: the
  banner is gone.
- With a server running, click the rail's Servers button: the page shows
  with Back, and Back returns to the workspace that was open.

`test-playwright-scripts/desktop-server-picker.js` drives these against a real
Electron build, and `test-playwright-scripts/desktop-onboarding.js` drives a
setup against stand-in `brew` and `yaac` commands.

The auth daemon:

- After launch, `GET /api/auth/agent` on the server answers
  `{"connected":true}`, and after Quit `false`.
- Switching servers on the Servers page moves it to the new one.
- For the packaged app, launch from Finder and complete a Claude and a Codex
  sign-in from the SPA cards. Success shows the daemon found the CLIs on the
  login-shell PATH.

`test-playwright-scripts/desktop-auth-daemon.js` checks the first point and a
stubbed sign-in under node-pty, against a dev or a packaged build.
