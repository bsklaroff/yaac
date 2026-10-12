# How a client finds its server

Every client on a machine (the CLI, the desktop shell and its auth daemon)
reaches its yaac server through an **origin** recorded in
`~/.yaac-client/server.json`, whatever driver the server uses and wherever it
runs. Clients never read the server's lock file and hold no credential.
Only the `yaac` CLI starts a server; the desktop shell does so by running
it. The server identifies the caller from the request
(docs/remote-hosting.md "Security model").

```
yaac server start ──(containerless)───────┐
                                          ├─► registerServer(origin, driver)
yaac cluster install|start|restart ──(k8s)┘            │
                                                       ▼
                                  ~/.yaac-client/server.json
                                                       │
                         CLI ─ desktop + auth daemon ─ test fixtures
```

## Why there is no local shortcut

Under `k8s` the server is a pod (docs/server-in-cluster.md). Its lock
records the port inside the pod, and `127.0.0.1:<that port>` on the host is
some unrelated listener, possibly another yaac that would answer and be
trusted. The only way to reach it is its published origin.

A containerless server registers the same way, so no client branches on
where the server runs: the CLI has no lock fallback, the desktop has no
"Local server" entry, and a bug in one driver's path cannot hide behind the
other's.

## Registration

`registerServer(origin, driver)` in `@yaac/shared/server-config` is the only
registration. `yaac server start|restart` calls it for the host process it
spawns, and `yaac cluster install|start|restart` for the Deployment. It
records the driver and the origin in the data dir's `install.json` and
saves the origin, keeping the other saved servers. A start selects the origin. A restart or a
re-install selects it only when it is new or no other server is selected,
so maintaining one install never moves clients off the other.

`yaac server run` is the server process itself (what `start` spawns, what
the server image runs, what e2e fixtures spawn) and registers nothing; the
client-local directory is not even mounted into the pod. `yaac server start`
also registers when a server is already running, so a server started with
`yaac server run` becomes reachable by running `start`.

## What `server.json` holds

```json
{ "url": "http://127.0.0.1:8787", "saved": [ { "url": "…" } ] }
```

- `url`: the selected server, or `""` for none. There is one selection at a
  time.
- `saved`: every server configured and not since removed, so a client can
  switch back.

The CLI edits it the way the desktop app's Servers page does: `yaac remote add`
saves and selects a server, `connect` selects a saved one, `disconnect`
deselects without forgetting, `list` shows them, and `remove` forgets one
other than the selected server. Both clients probe a server before
selecting it, so a server that is down or will not identify this device
never becomes the selection.

Nothing else: what kind of install a data dir is lives in its
`install.json`, so forgetting servers never loses it, and a moved data dir
takes its record with it. A `server.json` an older `yaac` wrote a copy of
the record into is cleaned on the first read, and `enabled` is still written
for older clients (docs/legacy-compat-shims.md).

## What `install.json` holds

Each data dir records the install it is in `<dataDir>/install.json`
(`@yaac/shared/install-record`): `driver`, the `origin` its server last
registered at, and for a cluster also `installId`, `clusterUid`,
`kubeContext` and `byo` (see the `InstallRecord` type). `yaac server|cluster
status --json` report the origin, and the desktop shell lets only pages
from a running install's origin drive this Mac's servers. It describes the data dir ("is there a host server to start, or a
Deployment to update?"), which does not change when the selection points
elsewhere, so `yaac remote connect https://elsewhere` cannot allow a host
`yaac server start` on a k8s install. `recordedDriver` reads `driver`, and
`assertHostServerAllowed` refuses on it. A remote server's driver is not
recorded; its snapshot reports it.

## Two installs on one machine

A machine can run the host server and a cluster's side by side. With no
`YAAC_DATA_DIR`:

| | data dir | commands | published at |
|---|---|---|---|
| host (containerless) | `~/.yaac-server` | `yaac server …` | `127.0.0.1:8787` |
| cluster (k8s) | `~/.yaac-cluster` | `yaac cluster …` | `127.0.0.1:8790` |

Both register in the one `~/.yaac-client/server.json`, so every client can
switch between them like any two servers. `yaac cluster …` points the
process at the cluster's data dir before it runs (`clusterDataDir`), while
the client tier stays where it is. A `~/.yaac` that is already a cluster
install stays one, and a host install still in `~/.yaac` is used there
until it can be moved (docs/legacy-compat-shims.md).

`YAAC_DATA_DIR` names one data dir for every command, so that dir is one
install of either kind. The test harness works this way.

## Nothing selected

`yaac remote disconnect` (or a fresh install) leaves nothing selected, and every
client says:

```
No yaac server selected.
    Start one on this machine with `yaac server start` (or, for a cluster, `yaac cluster install` once and then `yaac cluster start`),
    or connect to one with `yaac remote connect <url>` (`yaac remote list` shows them).
```

No client starts a server to recover. The CLI reports and exits; the desktop
shows its Servers page, which offers a start only when the user asks for one.
Every start goes through the CLI, which keeps a client from spawning a host
process next to a Deployment.

## Build mismatch is a warning

Client and server upgrade independently, and a local server may be a
Deployment running an older bundle. So a build-id mismatch is a warning,
printed once per client (`describeBuildSkew`). For a loopback origin it names
the fix: `yaac server restart` or `yaac cluster install`. Only `yaac server
start` treats a mismatch as fatal, checking the running server's build id
before reporting success.

The desktop shell passes `warnOnBuildSkew: false`: it ships no server code,
so it has no build to compare, and any server serves it a matching SPA.

## The desktop shell

The shell reads `server.json`, calls `/whoami` (checking both reachability
and that the server will identify this device), and loads the origin. It
never reads a lock.

Which server the app uses is chosen on the shell's own **Servers page**, not
in the SPA: the SPA is served by a server, so a server list inside it would
vanish exactly when no server answers. The page is an HTML string on a
`data:` URL, like the boot splash, so it needs no renderer bundle. The
window shows it in three cases, all the same page:

- no server is reachable (nothing selected, server down, or device not
  identified): it states the failure verbatim above the list, with Try
  again, instead of an error dialog over a blank window;
- a Mac with no `yaac`, or with no install and nothing selected: it leads
  with the two installs to set up;
- the user opens it, from the SPA's Servers button in the rail, the server
  badge in the sidebar header, or the tray: it covers the server's page,
  whose events and forwards keep running, and Back returns to the page it
  covered.

It is one list of servers. This Mac's installs are named **Local
containerless server** and **Local Kubernetes cluster**, with their origins
in parentheses (the tray names them the same way), each with a Start or
Stop; every other saved origin has Connect and Remove. Once the page has
loaded, each saved origin is probed in parallel and marked "(stopped)" when
it does not answer, or "(refused)" when it answers but will not identify
this device (a tagged tailnet device, or an origin for the wrong access
mode, docs/remote-hosting.md), with the server's reason as its tooltip:
starting the server would not fix that. The selected row has
**Disconnect**, which deselects it as `yaac remote disconnect` does, and
stopping the selected install disconnects the window the same way a dead
server would. Below the list are the setups of the installs this Mac lacks,
and a form that accepts a new origin.

A server on another machine is reached only over the tailnet, so while no
interface holds a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48)
the page warns that Tailscale does not seem to be running, and a switch to
or an add of a non-loopback origin whose probe goes unanswered names
Tailscale as the likely cause. Reading the interfaces rather than asking
the `tailscale` CLI covers the Mac app, whose CLI is usually off PATH, and
the brew daemon alike. It is only a hint, so it never stops a probe: a
Headscale tailnet may use other ranges, and other VPNs may use these.

It sets up, starts and stops this machine's servers only when the user asks,
always by running `brew` and `yaac server start|stop|restart` or `yaac
cluster install|start|stop` (packages/desktop/README.md, "This machine's
servers" and "Setup"). A setup ends the way the terminal's commands do:
`yaac server start` or the first `yaac cluster install` registers and
selects the new origin, and the shell lands on it.

Only that page may change servers or drive this Mac's: the main process
answers its bridge for the main window's top frame showing a `data:` page,
which only the shell loads. A server's page can only ask the shell to show
it. So a remote server cannot move the machine onto a server it chooses,
and a port the app forwards onto loopback cannot pass for one of this Mac's
servers.

Connect on the already-selected origin is a real retry, not a no-op. That is
how the page reaches a server that has come back up. Remove asks first in a
native dialog, and refuses the selected origin, since dropping it would
leave the window on a server the machine no longer names; switch away first.
