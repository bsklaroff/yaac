# How a client finds its server

Every client on a machine (the CLI, the desktop shell, the auth daemon)
reaches its yaac server through an **origin** recorded in
`~/.yaac-client/server.json`, whatever driver the server uses and wherever it
runs. Clients never read the server's lock file, hold no credential, and
never start a server. The server identifies the caller from the request
(docs/remote-hosting.md "Security model").

```
yaac server start ──(containerless)──┐
                                     ├─► registerServer(origin, driver)
yaac cluster install ──(k8s)─────────┘            │
                                                  ▼
                             ~/.yaac-client/server.json
                                                  │
                    CLI ─ desktop ─ auth daemon ─ test fixtures
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
registration. `yaac server start` calls it for the host process it spawns,
and `yaac cluster install` for the Deployment it applies. In one atomic write
it selects the origin, keeps the other saved servers, and records the
driver.

`yaac server run` is the server process itself (what `start` spawns, what
the server image runs, what e2e fixtures spawn) and registers nothing; the
client-local directory is not even mounted into the pod. `yaac server start`
also registers when a server is already running, so a server started with
`yaac server run` becomes reachable by running `start`.

## What `server.json` holds

```json
{ "url": "http://127.0.0.1:8787", "enabled": true,
  "saved": [ { "url": "…" } ], "driver": "containerless" }
```

- `url`: the selected server. `enabled: false` deselects it without
  forgetting it.
- `saved`: every server ever configured, so a client can switch back. There
  is one selection at a time.
- `driver`: the driver **this install** runs, not the selected server's. A
  k8s install also records `installId`, `clusterUid`, `kubeContext` and
  `byo` (see the `ServerConfig` type).

The install fields are top-level because they describe this data dir ("is
there a host server to start, or a Deployment to update?"), which does not
change when the selection points elsewhere. So `yaac remote set
https://elsewhere` cannot allow a host `yaac server start` on a k8s install.
`recordedDriver` reads `driver`, and `assertHostServerAllowed` refuses on it.
A remote server's driver is not recorded; its snapshot reports it.

For the same reason `yaac remote unset` clears the selection but keeps the
install fields, deleting the file only when there are none. Losing `driver`
would let a host start run beside a k8s install, with two servers writing one
PGlite directory.

## Nothing selected

`yaac remote off` (or a fresh install) leaves nothing selected, and every
client says:

```
No yaac server selected.
    Start one on this machine with `yaac server start` (or `yaac cluster install` on a k8s install),
    or point at one with `yaac remote set <url>`.
```

All three commands are listed because this message prints exactly when
nothing on disk says which kind of install this is.

No client starts a server to recover. The CLI reports and exits; the desktop
shows its picker. Only `yaac server start` starts one, which keeps a client
from spawning a host process next to a Deployment.

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
never reads a lock or starts a server (see packages/desktop/README.md).

When no server is reachable (nothing selected, server down, or device not
identified), the window shows a **picker** instead of an error dialog: with
no server there is no SPA, and a dialog over a blank window leaves nothing to
click. The picker is an HTML string on a `data:` URL, like the boot splash,
so it needs no renderer bundle. It shows the failure verbatim, lists saved
origins with Connect buttons, and accepts a new origin. It uses the same
preload bridge as the SPA's Settings → Server section, so both reach the same
main-process handlers, which re-validate input.

Connect on the already-selected origin is a real retry, not a no-op. That is
how the picker reaches a server that has come back up.
