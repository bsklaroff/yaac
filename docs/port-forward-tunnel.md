# Reaching a workspace's ports

A workspace's dev server listens on a port the user wants to preview. The
yaac server never binds that port on the user's machine; a client does, on
its own loopback, and previews it there.

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
registry, and "stop forwarding" removes from it. The result appears as
`forwardedPorts` on the workspace list, which client forwarders bind and the
webapp offers to preview. A client drops a port that leaves the list,
cutting its open connections too.

Declaring also allocates: if two workspaces of a project both ask for 3000,
the k8s driver gives the second the next free port. It cannot see what else
holds a port on the user's machine, so a clash there is the client's to
resolve (see "Taken ports"). Under `containerless` the mapping is the
identity at a port allocated for that workspace, which its dev server is
told to bind (docs/workspace-hostnames.md).

Every workspace port also has a hostname, `<port>.<id8>.localhost`. The
server routes these names on its own listener for its own machine, and
`yaac forward` and the desktop app route them for a server elsewhere
(docs/workspace-hostnames.md).

**A client binds.** `startForward` in `@yaac/shared` listens on the host port
and, per accepted TCP connection, opens a WebSocket to
`GET /api/forward/attach?id=<workspace>&port=<container port>`, authenticated
like every other WebSocket (docs/remote-hosting.md). The server connects it
to a `dialPort` stream into the workspace (`attachPortTunnel`); under k8s
that is a `tcp` stream through the pod's streamd (docs/stream-relay.md).

`id` must be an exact workspace id (missing is a 400). The k8s driver dials
only a port the workspace forwards (config-declared, or forwarded from the
webapp), so a listener the detector merely suggests stays unreachable until
the user forwards it, and so does yaac's in-pod infra range (`isInfraPort`),
which configs cannot declare.

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
- **A tunnel has no heartbeat.** One that dies silently, as a connection
  held across a laptop sleep can, is never closed, and the local end stays a
  healthy loopback socket. A long-lived stream through it (a dev server's HMR
  WebSocket, an SSE feed) then hangs until the browser gives up on it. New
  connections are unaffected. The `/events` stream that decides which ports
  are bound does have one (`startEventsMonitor`).

The client lives in `@yaac/shared` because the desktop app is a forwarder
and may import nothing else. It depends only on `ws` and `net`. The iPhone
app has its own copy in Swift (`ios/Yaac/PortForward.swift`).

## The forwarders

`createForwardSet` keeps a set of forwards in line with a desired list,
matched by identity: a new port does not disturb other forwards' open
connections, and a forward that cannot bind (nor fall back, see "Taken
ports") is reported and retried next pass. `yaac forward` and the desktop app take that list
from the server's `/events` snapshots (`startEventsMonitor` and
`snapshotForwards` in `@yaac/shared`):

- **`yaac forward [workspace-id]`**, for headless machines. It follows
  every running workspace's ports, or the named one's.
  `--port <container[:host]>` names ports directly (some of the offered
  ones, or at a different local port; the workspace must still forward
  each), and
  `--bind <address>` listens somewhere other than loopback, for a
  forwarder that is not on the user's machine.
- **The desktop app**, resident in the tray. The stream that drives its
  badge drives the forwards too, so its preview pane, and any browser on the
  same machine, reach `127.0.0.1:<port>` whenever the app runs. It binds
  loopback only, never exposing dev servers to the local network.
- **The iPhone app** forwards one port at a time, only while its preview
  shows it (ios/README.md "Previews"). iOS suspends a backgrounded app, so
  a standing set of forwards would not survive anyway.

## Where a preview is offered

The desktop and iPhone apps offer a preview of every forwarded port: each
reaches the port on its own loopback and shows the page in its own web view.
A browser cannot hold a listener, so it gets a preview only when the page
came from a server on its own machine, which routes the workspace hostnames
on its own port. That preview opens in a new tab
(docs/workspace-hostnames.md). A browser on a remote origin gets no preview
and no port links. (Even with a listener on the server host, a browser would
refuse a plain-http link to a `*.ts.net` name, which is on the browsers'
HSTS preload list.) The iPhone app tells the webapp it can preview by giving
its bridge an `openPreview` call (`windowApi()` in
`packages/frontend/src/components/WindowControls.tsx`).

The desktop app's preview pane loads the port's workspace hostname, so
previews of different workspaces keep their cookies apart and a preview
reaches the workspace whatever else holds that port number on this machine.
Until the app knows where the names are routed, the pane waits. It
previews each forwarded port in its own pane, so a
workspace can show several side by side. A pane is a `preview:<port>`
layout target (`#lib/preview`), so the saved layout remembers which port
each pane shows across reloads and server switches. A pane whose port is
not forwarded at the moment waits for it rather than showing another,
including when another client stops the forward. Stopping a forward from
the pane's own window closes the pane.

## Taken ports

Another process on the client's machine may already hold an offered host
port: a local kind cluster's server on 8790, say, while a remote workspace
offers 8790 too. A tool pointed at that port would then quietly reach the
other process. So the desktop app and `yaac forward` bind the next free port
above it instead (`fallback` in `createForwardSet`), skipping ports other
forwards in the set ask for, and keep that port for as long as the server
offers the forward, so the URL does not move under an open page.

The server never learns of the move; the client reports it:

- **`yaac forward`** prints the port it bound, with `(port N is in use
  here)`. A port named with `--port` is bound as named or not at all.
- **The desktop app** writes the move to its log. Its preview pane loads
  the workspace hostname, which names the workspace rather than a port
  number here, so a move never sends the preview to the wrong process.
- **The iPhone app** binds a free port when the offered one is taken and
  loads its preview from whichever it bound. Nothing else on the phone can
  use that port (see ios/README.md "Previews"), so the webapp never needs
  to know, and labels the port with the workspace's alone.

## Containerless servers

**On the server's machine** the workspace's processes already hold the
ports. A forwarder would fail to bind against the dev server, or bind first
and steal the port from it. So the desktop app and `yaac forward` check
(`serverNeedsForwarder` in `@yaac/shared`): `yaac forward` refuses with the
reason, and the desktop binds nothing.

**On any other machine** the ports are as unreachable as a pod's, and the
tunnel works the same way: the client binds the identity mapping, and the
driver's `dialPort` connects to the port on the server host. So the desktop
and iPhone previews work against a remote containerless server too.

Only a listener the containerless port sweep found can be dialled, at the
address it is bound to. The sweep covers only the workspace's process tree,
which acts as an allowlist, with the sensitive-port denylist on top
(docs/containerless-driver.md "Ports"). The k8s driver also dials a forwarded
port with nothing listening yet, so a forward survives a dev server restart;
that is fine in a sandboxed pod but not on the user's own machine.

A client decides whether it is on the server's machine from its resolved
origin (`isLoopbackOrigin`), so an `ssh -L` tunnel to a remote containerless
server counts as local and is not forwarded. An explicit `yaac forward --bind
<addr>` skips the refusal, loopback included: on the server host it
publishes the ports on another interface and relays each connection to
loopback, which is not the address the dev server holds. Anything that can
reach that address then reaches the ports, with no identity check.
