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
records the driver in the data dir's `install.json` and saves the origin,
keeping the other saved servers. A start selects the origin. A restart or a
re-install selects it only when it is new or no other server is selected,
so maintaining one install never moves clients off the other.

`yaac server run` is the server process itself (what `start` spawns, what
the server image runs, what e2e fixtures spawn) and registers nothing; the
client-local directory is not even mounted into the pod. `yaac server start`
also registers when a server is already running, so a server started with
`yaac server run` becomes reachable by running `start`.

## What `server.json` holds

```json
{ "url": "http://127.0.0.1:8787", "enabled": true,
  "saved": [ { "url": "…" } ] }
```

- `url`: the selected server. `enabled: false` deselects it without
  forgetting it.
- `saved`: every server configured and not since removed, so a client can
  switch back. There is one selection at a time.

What kind of install a data dir is lives in its `install.json`, so
forgetting servers never loses it. For an older `yaac`, which reads it only
here, `server.json` also carries a copy of the client data dir's record, and
`yaac remote unset` keeps the file while it does (docs/legacy-compat-shims.md).

## What `install.json` holds

Each data dir records the install it is in `<dataDir>/install.json`
(`@yaac/shared/install-record`): `driver`, and for a cluster also
`installId`, `clusterUid`, `kubeContext` and `byo` (see the `InstallRecord`
type). It describes the data dir ("is there a host server to start, or a
Deployment to update?"), which does not change when the selection points
elsewhere, so `yaac remote set https://elsewhere` cannot allow a host
`yaac server start` on a k8s install. `recordedDriver` reads `driver`, and
`assertHostServerAllowed` refuses on it. A remote server's driver is not
recorded; its snapshot reports it.

## Two installs on one machine

A machine can run the host server and a cluster's side by side. With no
`YAAC_DATA_DIR`:

| | data dir | commands | published at |
|---|---|---|---|
| host (containerless) | `~/.yaac` | `yaac server …` | `127.0.0.1:8787` |
| cluster (k8s) | `~/.yaac-cluster` | `yaac cluster …` | `127.0.0.1:8790` |

Both register in the one `~/.yaac-client/server.json`, so every client can
switch between them like any two servers. `yaac cluster …` points the
process at the cluster's data dir before it runs (`clusterDataDir`), while
the client tier stays where it is. A `~/.yaac` that is already a cluster
install stays one (docs/legacy-compat-shims.md).

`YAAC_DATA_DIR` names one data dir for every command, so that dir is one
install of either kind. The test harness works this way.

## Nothing selected

`yaac remote off` (or a fresh install) leaves nothing selected, and every
client says:

```
No yaac server selected.
    Start one on this machine with `yaac server start` (or, for a cluster, `yaac cluster install` once and then `yaac cluster start`),
    or point at one with `yaac remote set <url>`.
```

No client starts a server to recover. The CLI reports and exits; the desktop
shows its picker, which offers a start only when the user asks for one.
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
never reads a lock. It sets up, starts, stops and restarts this machine's
servers only when the user asks, from the tray, the picker or Settings →
Server, and always by running `brew` and `yaac server start|stop|restart`
or `yaac cluster install|start|stop` (packages/desktop/README.md, "This
machine's servers" and "Setup"). A setup ends the way the terminal's
commands do: `yaac server start` or the first `yaac cluster install`
registers and selects the new origin, and the shell lands on it. Only the
picker and pages served from loopback may ask for any of this; a remote
server's page gets the server-switching bridge but not this Mac's servers.

When no server is reachable (nothing selected, server down, or device not
identified), the window shows a **picker** instead of an error dialog: with
no server there is no SPA, and a dialog over a blank window leaves nothing to
click. The picker is an HTML string on a `data:` URL, like the boot splash,
so it needs no renderer bundle. It shows the failure verbatim, lists saved
origins with Connect buttons, and accepts a new origin. On a Mac with no
`yaac`, or with no install and nothing selected, it leads with the two
installs to set up instead. It uses the same
preload bridge as the SPA's Settings → Server section, so both reach the same
main-process handlers, which re-validate input.

Connect on the already-selected origin is a real retry, not a no-op. That is
how the picker reaches a server that has come back up.

Settings → Server can also remove a saved origin. The connected one is
refused, since dropping it would leave the window on a server the machine no
longer names; switch away first.
