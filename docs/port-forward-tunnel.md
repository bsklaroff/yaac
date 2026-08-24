# Reaching a worktree's ports

A worktree's dev server listens on a port the user wants to open in a
browser. Who binds that port on the user's machine is the whole subject
of this document, and the answer is: **not the server**.

- Under `k8s` the server is a pod (docs/server-in-cluster.md). A port it
  bound would be on the pod's loopback — the bind succeeds, every health
  signal reads green, and the link answers nothing on the machine showing
  it. That is the worst failure shape available, so the server does not
  bind at all.
- Under `containerless` the workspace's own processes bind host ports, so
  the port is already reachable and there is nothing to forward.

Neither substrate leaves the server holding a listener. What it holds
instead is the **mapping** — which container port is offered at which host
port — and the near end of each connection.

## The two halves

**The server declares.** `WorktreeDriver.declareForwards` takes a config's
`portForward` entries and answers the host port each is offered at, held
for the workspace's lifetime and dropped by `deregisterWorkspace`. It runs
before the workspace launches, because its answer is stamped into the
workspace's own tmux status bar. The reactive "forward this port" action
(docs/auto-forward-ports.md) appends to the same registry. Either way the
result surfaces as `forwardedPorts` on the worktree list, which is what the
webapp links to and what a client forwarder binds.

Declaring is also **allocating**. Binding used to disambiguate two
workspaces of one project both asking for 3000 — whoever bound first won
and the second walked up. With nothing bound, the k8s driver's registry
keeps the ledger and walks the same way. What it cannot know is what else
on the user's machine holds a port; that surfaces where it can be
observed, as the client's listener failing to bind. Under `containerless`
the answer is the identity: the port the config names IS the port the dev
server binds, and reserving anything in its name would take it away.

**A client binds.** `startForward` in `@yaac/shared` listens on the host
port and opens one WebSocket per accepted TCP connection to
`GET /forward/attach?id=<workspace>&port=<container port>`, authenticated
by the same bearer every other WS carries. The server splices that socket
to a `dialPort` stream into the workspace (`attachPortTunnel`) — under k8s,
a `tcp` stream through the pod's streamd, exactly the relay every other
byte rides (docs/stream-relay.md).

One WebSocket per TCP connection is the kubectl shape, and it is what makes
the splice the entire protocol: every binary frame is bytes for that one
connection, in order, with nothing to demultiplex. A chatty client pays one
handshake per connection; multiplexing is a follow-up, wanted only if that
cost becomes visible.

Two details the shape forces:

- **Both ends buffer the first bytes.** A TCP client writes its whole
  request the moment it connects, before the handshake finishes — so the
  client pauses the socket until the WS opens, and the server queues frames
  that arrive before its dial lands. Dropping them would look like a hang
  rather than an error.
- **A refused dial closes with 4001.** The dial happens inside the cluster
  where the client cannot look, so the close code is the whole diagnosis it
  gets, and it has to be tellable from a dev server that simply hung up.

`@yaac/shared` is where the client lives because the desktop app is one of
the two forwarders and may import nothing else. It uses `ws` and `net` and
nothing further.

## The two forwarders

`createForwardSet` reconciles a live set of forwards against a desired
list, by identity — so a session gaining a port never costs the others
their open connections, and a forward that cannot bind is reported and
retried on the next pass rather than failing the set. Both clients drive
it:

- **`yaac forward [worktree-id]`** — the explicit one, for a headless box.
  It polls the worktree list every few seconds, so a session created,
  stopped, or granted a new port while it runs is picked up. `--port
  <container[:host]>` names ports directly instead (for one the server has
  not heard of, or one wanted on a different local number), and `--bind`
  puts the listeners somewhere other than loopback — the remote-hosting
  case (docs/remote-hosting.md), where the machine running the forwarder is
  not the machine at the keyboard.
- **The desktop app** — the resident one. Its main process is long-lived,
  tray-scoped and already holds `/events`, whose snapshots carry the
  mappings; so the stream that drives the badge drives the forwards, and
  the webapp's `127.0.0.1:<port>` links are true whenever the app is
  running. Loopback only: a desktop app quietly serving a developer's dev
  servers to the local network would be a surprise.

Nothing is forwarded when neither is running. That is the honest state —
the mapping exists, the listener does not — and it is visible: the link is
there and refuses to connect, rather than answering something else.

And neither forwards against a **containerless** server, by construction.
There the mapping is the identity over ports a workspace's own processes
have ALREADY bound on this machine, so a forwarder has nothing to add and
nowhere to put a listener: every bind loses to the dev server holding the
port, and against a remote containerless server the binds succeed only for
each tunnelled connection to die, since that driver's `dialPort` is a
refusal. Left to discover this per connection it is a retry loop that can
never settle, so both clients stop first — `yaac forward` refuses with the
reason, and the desktop's `snapshotForwards` offers nothing when the
snapshot's `driver` says containerless.
