# Reaching a workspace's ports

A workspace's dev server listens on a port the user wants to open in a
browser. The yaac server never binds that port on the user's machine; a
client does.

- Under `k8s` the server is a pod (docs/server-in-cluster.md). A port it
  bound would be on the pod's loopback: the bind succeeds, health checks
  pass, and the link reaches nothing on the user's machine. So the server
  binds nothing.
- Under `containerless` the workspace's own processes bind host ports, so on
  the server's machine there is nothing to forward. From another machine
  there is (see "Containerless servers").

The server holds the **mapping** (which container port is offered at which
host port) and the server end of each connection.

## The server declares, a client binds

**The server declares.** `WorkspaceDriver.declareForwards` takes a config's
`portForward` entries and returns the host port each is offered at, kept for
the workspace's lifetime and dropped by `deregisterWorkspace`. It runs before
launch because the result is shown in the workspace's tmux status bar. The
"forward this port" action (docs/auto-forward-ports.md) adds to the same
registry. The result appears as `forwardedPorts` on the workspace list, which
the webapp links to and client forwarders bind.

Declaring also allocates: if two workspaces of a project both ask for 3000,
the k8s driver gives the second the next free port. It cannot see what else
holds a port on the user's machine; that shows up as the client failing to
bind. Under `containerless` the mapping is the identity, since the config's
port is the port the dev server binds.

**A client binds.** `startForward` in `@yaac/shared` listens on the host port
and, per accepted TCP connection, opens a WebSocket to
`GET /api/forward/attach?id=<workspace>&port=<container port>`, authenticated
like every other WebSocket (docs/remote-hosting.md). The server connects it
to a `dialPort` stream into the workspace (`attachPortTunnel`); under k8s
that is a `tcp` stream through the pod's streamd (docs/stream-relay.md).

`id` must be an exact workspace id (missing is a 400). The k8s driver dials
only a port the workspace declared or its detector surfaced, never yaac's
in-pod infra range (`isInfraPort`), which configs cannot declare either.

One WebSocket per TCP connection, as kubectl does, keeps the protocol
trivial: each binary frame is the next bytes of that one connection. The
cost is a handshake per connection. Two details follow:

- **Both ends buffer the first bytes.** A TCP client often sends its request
  before the WebSocket is open, so the client pauses the socket until then,
  and the server queues frames that arrive before its dial completes.
  Dropping them would look like a hang.
- **A failed dial closes with code 4001.** The client cannot see into the
  cluster, so the close code is its only diagnosis, and it must differ from a
  dev server closing the connection.

The client lives in `@yaac/shared` because the desktop app is a forwarder
and may import nothing else. It depends only on `ws` and `net`.

## The two forwarders

`createForwardSet` keeps a set of forwards in line with a desired list,
matched by identity: a new port does not disturb other forwards' open
connections, and a forward that cannot bind is reported and retried next
pass. Two clients use it:

- **`yaac forward [workspace-id]`**, for headless machines. It polls the
  workspace list every 3 seconds. `--port <container[:host]>` names ports
  directly (one the server does not know, or a different local port), and
  `--bind <address>` listens somewhere other than loopback, for remote
  hosting (docs/remote-hosting.md) where the forwarder is not on the
  user's machine.
- **The desktop app**, resident in the tray. Its main process already
  follows `/events`, whose snapshots carry the mappings, so the stream that
  drives the badge drives the forwards and the webapp's `127.0.0.1:<port>`
  links work whenever the app runs. It binds loopback only, never exposing
  dev servers to the local network.

With neither running, nothing is forwarded: the link is shown but refuses to
connect.

## Containerless servers

**On the server's machine** the workspace's processes already hold the
ports. A forwarder would fail to bind against the dev server, or bind first
and steal the port from it. So both clients check (`serverNeedsForwarder` in
`@yaac/shared`): `yaac forward` refuses with the reason, and the desktop's
`snapshotForwards` returns nothing.

**On any other machine** the ports are as unreachable as a pod's, and the
tunnel works the same way: the client binds the identity mapping, and the
driver's `dialPort` connects to the port on the server host. So the desktop
preview pane works against a remote containerless server too.

Only a listener the containerless port sweep found can be dialled, at the
address it is bound to. The sweep covers only the workspace's process tree,
which acts as an allowlist, with the sensitive-port denylist on top
(docs/containerless-driver.md "Ports"). The k8s driver also dials a declared
port with nothing listening yet, so a forward survives a dev server restart;
that is fine in a sandboxed pod but not on the user's own machine.

A client decides whether it is on the server's machine from its resolved
origin (`isLoopbackOrigin`), so an `ssh -L` tunnel to a remote containerless
server counts as local and is not forwarded. An explicit `yaac forward --bind
<addr>` skips the refusal, loopback included. It exists for the
remote-hosting recipe (docs/remote-hosting.md): on the server host it
publishes the ports on another interface and relays each connection to
loopback, which is not the address the dev server holds.
