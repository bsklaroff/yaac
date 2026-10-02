# Stream relay: workspace streams off the apiserver

Under the `k8s` driver, every steady-state byte between the server and a
workspace pod travels over plain TCP through the proxy pod to a daemon
inside the workspace pod (streamd). That covers terminal PTYs, the status
watcher's tmux control stream, forwarded TCP ports, and one-shot pod
commands. None of it goes through the Kubernetes apiserver.

Streaming through `kubectl exec` would cost a kubectl child per stream (or
per TCP connection), and every chunk would cross pod → containerd shim →
kubelet → apiserver → kubectl → server. gVisor makes the pod end of that
path especially slow.

Workspace setup uses the relay too. The pod's postStart hook
(`workspace-bin/yaac-workspace-init`) starts streamd before the container
reports Ready, so every setup command the server runs after that is a
relay exec. Claiming a prewarmed spare waits on `waitForStreamd` before its
first change, then does its re-branching and git-identity work over the
relay.

`kubectl exec` is used only where there is no stream to wait on: restarting
streamd itself (`bootStreamd`), the image-salvage survey at teardown, and
infrastructure pods that are not workspaces.

## Architecture

```
browser ── WS ── server ──(A)── proxy pod ──(B)── workspace pod
                             relay listener :10260   streamd :10300
                             (auth + splice)         (pty/ctrl/exec/tcp)

server = a pod of the install namespace, dialing the proxy's Service
```

### streamd (`dockerfiles/streamd/`)

A small plain-JS Node daemon, baked into the base image at
`/opt/yaac/streamd` with a prebuilt `@lydell/node-pty`. The postStart setup
script starts it last, so a successful relay exec also proves the earlier
setup (git config, tmux server) is done. Its source is part of the base
image's content hash, so editing it changes the image tag.

It listens on `0.0.0.0:10300`, reachable at the pod IP. Each connection
starts with one JSON handshake line (`{token, kind, …params}`) and gets one
`{ok}` reply line. The kinds are:

- `tcp {port}`: raw splice to `localhost:<port>` inside the pod. Dialing
  from inside the pod is what lets a dev server bound only to localhost be
  forwarded; dialing `podIP:port` from the proxy could not reach it.
- `ctrl {cmd}`: run a command with piped stdio and splice stdin/stdout raw
  (tmux control mode is a line protocol). Closing the socket kills the
  process. ACP uses this too: an `acp` workspace runs `socat -
  UNIX-CONNECT:/tmp/yaac-acp/<window>.sock` here and JSON-RPC rides the
  raw duplex. Because closing the socket kills the child, the ACP agent
  itself runs under acpd in a tmux window, not as this stream's child
  (docs/agent-modes.md).
- `exec {cmd}`: run a command once, reply with one JSON line
  `{exitCode, stdout, stderr}` (size-bounded), and close. This is what
  `podExec` uses.
- `pty {cmd, cols, rows}`: run a command under a PTY. Both directions are
  framed as `[1B type][4B BE length][payload]` (codec shared with
  `@yaac/shared/stream-frames`): data, resize and signal frames in; data and
  exit frames out. Output pauses when the socket applies backpressure.
- `ports {}`: stream the pod's listening TCP ports (read from
  `/proc/net/tcp{,6}`, loopback and wildcard binds only, streamd's own port
  left out) as JSON lines: once on connect, on every change, and
  periodically as a keepalive. This feeds the server's port detector
  (docs/auto-forward-ports.md). The scan runs only while a ports stream is
  open.

PTY output is micro-batched. The first write goes out at once; later writes
within the next ~8ms are merged into one frame, with a size cap. A tmux
redraw therefore reaches the browser as one message it can paint in one go,
which avoids cursor flicker from half-drawn screens, while a single
keystroke echo is not delayed. The server's PTY adapter delivers
consecutive data frames from one chunk as a single WebSocket message, and
`bridge()` runs the same batcher again before the socket
(`@yaac/shared/batcher`; streamd's `batcher.js` is a copy of it). That last
step gives the containerless driver, which has no streamd, the same
coalescing.

The handshake token is per workspace: `HMAC-SHA256(proxyAuthSecret,
workspaceId)`, derived rather than stored, and passed to the pod as
`YAAC_STREAM_TOKEN`. It backs up the ingress NetworkPolicies: a workspace
that leaks its own token gains nothing, because only its own streamd accepts
it and only the proxy can reach any streamd.

### Proxy relay listener (`k8s/proxy/main.ts`)

A minimal authenticated CONNECT on `:10260`, present in every proxy. For
each connection it reads one JSON auth line (`{token: proxyAuthSecret,
workspaceId}`, compared in constant time), looks up the workspace's pod IP
(from its pod watch, falling back to a label-selector list), dials
`podIP:10300` and splices. Everything after the auth line passes through
untouched, so the protocol is end-to-end between server and streamd.

Errors for a single stream (unknown workspace, pod dial failed) get an
`{ok:false}` line before the close. The server treats a silent close as a
dead peer, so a probe of a stale workspace must not look like one. Only a
bad auth line closes silently.

Everything before the splice has a deadline (auth line, IP lookup, pod
dial). A pod whose ingress policy does not yet admit the proxy drops the
SYN, and without the deadline the dial would wait out the OS retry series
while the server learned nothing.

### Server transport (`drivers/k8s/substrate/stream-relay.ts`)

`relayDial` opens the TCP connection and sends both handshake lines in one
write. The address is the proxy's Service,
`yaac-proxy.<namespace>.svc.cluster.local:10260`, dialed directly: the
server is a pod in that namespace (docs/server-in-cluster.md), and the
proxy's ingress policy admits the server's pods on the relay port. The
Deployment sets it as `YAAC_RELAY_ADDR`, which is used as given.

Streams share nothing. Each dial is its own TCP connection, so a failure
affects only its own caller, not other terminals, status streams or
forwarded ports. A caller's command timeout has a floor (5s) before the
dial deadline is derived from it: a probe that wants a fast answer should
not make a slow but healthy dial look like a dead relay.

Adapters give each consumer the interface it already used:
`dialCtrlStream` (child-process-shaped, for the status watcher),
`dialPtyStream` (PTY-shaped, for the terminal bridge), and `podExec` (the
one-shot runner behind tmux probes, terminal listing, the changes diff and
similar).

## The browser hop

The slowest link is usually the first one. A remote install serves the
server straight over Tailscale (docs/remote-hosting.md), so the
browser↔server WebSocket is the whole WAN path. Four things keep it cheap:

- **Compression.** Every WebSocket negotiates `permessage-deflate`
  (`server-run.ts`) with a 512-byte threshold, so small latency-critical
  frames (a keystroke, its echo, a control frame) skip compression. Large
  ANSI repaints and snapshot/ACP JSON benefit. `@hono/node-ws` does not
  pass options through, so the setting is applied to the `wss` it returns;
  `ws` reads it on each upgrade. `test/api/websocket-compression.test.ts`
  checks the negotiation so a dependency bump cannot silently drop it. The
  `/events` hub sends on the raw `ws` socket rather than Hono's
  `WSContext`, because the context passes `compress: undefined`, which
  overrides ws's default and would leave the largest payload uncompressed.
- **No Nagle.** Every relay socket sets `setNoDelay`: the server's dial,
  both sides of the proxy splice, and streamd's accepted and target
  sockets. The batchers already coalesce; Nagle on top would only add
  delay.
- **Keystroke batching.** The browser batches input with the same shared
  batcher on a 4ms window. A single keypress is sent at once; key repeat,
  a paste delivered in pieces, and a TUI's mouse reports stop costing one
  WebSocket frame and TLS record each.
- **Link measurement.** The PTY control channel's `ping` carries a client
  timestamp that the `pong` echoes, so the webapp can time the round trip.
  Each open pane probes every 10s and the samples go into one app-wide
  store (`frontend/src/lib/link-quality.ts`). A ping with no timestamp
  (the CLI's keepalive) still gets a plain pong.

## Failure model

When the relay is unreachable (proxy pod restarting, streamd dead), streams
fail and are retried by the existing layers: the status watcher's backoff
respawn, the frontend's WebSocket reconnect, and per-connection forward
errors.

Probe results are classified conservatively. Only a stream that reached the
pod and saw the command exit nonzero (`RelayExecError`) counts as a real
answer. Any transport failure (`RelayDialError`) is `unknown`, and the
stale reaper treats `unknown` as "do not reap". A proxy outage therefore
degrades terminals but never ends workspaces.

The status watcher restarts streamd itself: after every third consecutive
stream failure it re-runs the boot command through `kubectl exec`
(`bootStreamd`), since that works when no stream does.

## Network policy

Because the proxy dials workspace pods, pod ingress is locked down:

- Proxy ingress (`buildProxyIngressNpManifest`): the relay port is admitted
  from the node addresses (netd's Envoy, the kubelet probe) and from the
  server's pod selector. Workspace pods match neither.
- Workspace ingress lock (`buildWorkspaceIngressLockNpManifest`): workspace
  pods accept only `app=yaac-proxy` on 10300 and deny all other ingress.

The proxy's control API is a separate port on the same Service, admitted by
the same rule from the server's pods.
