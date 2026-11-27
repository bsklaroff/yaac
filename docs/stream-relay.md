# Stream relay: workspace streams off the apiserver

Under the `k8s` driver, every steady-state byte between the server and a
workspace pod travels over plain TCP to netd's relay on the workspace's
node, and from there through the pod's `ingress.sock` to a daemon inside the
workspace pod (streamd). That covers terminal PTYs, the status
watcher's tmux control stream, forwarded TCP ports, and one-shot pod
commands. None of it goes through the Kubernetes apiserver.

Streaming through `kubectl exec` would cost a kubectl child per stream (or
per TCP connection), and every chunk would cross pod → containerd shim →
kubelet → apiserver → kubectl → server. gVisor makes the pod end of that
path especially slow.

Workspace setup uses the relay too. The pod's postStart hook
(`workspace-bin/yaac-workspace-init`) starts streamd before the container
reports Ready, so every setup command the server runs after that is a
relay exec. Making a pod its workspace's is one `claim` stream to streamd
(docs/generic-workspace-pods.md "A claim"), and the session's windows open
over the relay after it.

`kubectl exec` is used only where there is no stream to wait on: restarting
streamd itself (`bootStreamd`), and infrastructure pods that are not
workspaces.

## Architecture

```
browser ── WS ── server ──(A)── netd pod on the ──(B)── workspace pod
                                workspace's node        netshim ── streamd :10300
                                relay :10262            (ingress.sock)  (pty/ctrl/exec/tcp)
                                (auth + splice)

server = a pod of the install namespace, dialing the netd pod's address
```

### streamd (`daemons/streamd/`)

A static Go binary, one per pod and spare, so it is built to cost little:
in a gVisor pod it rests at about 16 MB and starts in about 25 ms. Each
stream runs on its own goroutines, so starting a command, which takes a few
milliseconds in a sandbox, holds up only that stream, never another
terminal's echo.

`pnpm build:daemons` cross-compiles it for Linux on x64 and arm64, and the
server stages the build for its own architecture in its helpers folder,
which every pod it makes mounts at `/opt/yaac/helpers`
(docs/generic-workspace-pods.md "The pod"). No image carries it, so a change
to it rebuilds no image, and a pod always runs the streamd of the server
build that made it. The postStart setup script (`yaac-workspace-init`, from
the same folder) starts it last, so a successful relay exec also proves the
earlier setup (the passwd entry, the tmux server) is done.

It listens on `0.0.0.0:10300`, which in a sandbox with no interface is
reachable from its loopback alone: netshim dials it for each connection the
relay hands through `ingress.sock` (docs/workspace-egress.md "netshim"). Each connection
starts with one JSON handshake line (`{token, kind, …params}`) and gets one
`{ok}` reply line. The kinds are:

- `tcp {port}`: raw splice to `localhost:<port>` inside the pod. Dialing
  from inside the pod is what lets a dev server bound only to localhost be
  forwarded.
- `ctrl {cmd}`: run a command with piped stdio and splice stdin/stdout raw
  (tmux control mode is a line protocol). The client's EOF closes the
  command's stdin; a stream that can no longer take its output ends it.
- `unix {path}`: raw splice to a UNIX socket inside the pod, connected in
  streamd's own process and retried for about two seconds while the socket
  is not bound yet. ACP uses this: the server dials
  `/tmp/yaac-acp/<window>.sock`, where acpd republishes the agent's stdio,
  and JSON-RPC rides the raw duplex. The ACP agent itself runs under acpd in
  a tmux window, so a dropped stream leaves it running
  (docs/agent-modes.md).
- `exec {cmd, stdin?}`: run a command once, reply with one JSON line
  `{exitCode, stdout, stderr}` (size-bounded), and close. This is what
  `podExec` uses. With `stdin: n`, the next n bytes the client sends are the
  command's standard input; a long prompt's delivery script travels this
  way, since a command line is capped at 128 KiB (the handshake line's
  cap is twice that). Input cut short is never
  handed on, so a script never runs its first half. The command leads its
  own process group, and a stream the client closes before it finishes (a
  timed-out exec) kills the whole group, so nothing the command started
  keeps running.
- `pty {cmd, cols, rows}`: run a command under a PTY. Both directions are
  framed as `[1B type][4B BE length][payload]` (codec shared with
  `@yaac/shared/stream-frames`): data, resize and signal frames in; data and
  exit frames out. Writes block, so a client that reads slowly stops the
  terminal and, through it, the program.
- `ports {}`: stream the pod's listening TCP ports (read from
  `/proc/net/tcp{,6}`, loopback and wildcard binds only, streamd's own port
  left out) as JSON lines: once on connect, on every change, and
  periodically as a keepalive. This feeds the server's port detector
  (docs/auto-forward-ports.md). The scan runs only while a ports stream is
  open.
- `claim {bytes}`: make the pod one workspace's from the JSON request in
  the bytes that follow, inside streamd's own process (`claim.go`), since
  each process started in the sandbox costs tens of milliseconds: wait for
  the tree container's started marker, write `~/.gitconfig` and `~/.npmrc`,
  restore opencode's history, and open the tmux session with the
  workspace's variables. It replies with one JSON line and closes.

PTY output is micro-batched. The first write goes out at once; later writes
within the next ~8ms are merged into one frame, with a size cap. A tmux
redraw therefore reaches the browser as one message it can paint in one go,
which avoids cursor flicker from half-drawn screens, while a single
keystroke echo is not delayed. A frame never ends inside a UTF-8 character,
since the server decodes each one by itself. The server's PTY adapter delivers
consecutive data frames from one chunk as a single WebSocket message, and
`bridge()` runs the same batcher again before the socket
(`@yaac/shared/batcher`; streamd's batcher in `pty.go` follows the same
policy). That last
step gives the containerless driver, which has no streamd, the same
coalescing.

The handshake token is per workspace: `HMAC-SHA256(proxyAuthSecret,
workspaceId)`, derived rather than stored, and passed to the pod as
`YAAC_STREAM_TOKEN`. A workspace that leaks its own token gains nothing,
because only its own streamd accepts it and only netd's relay can reach any
streamd.

### netd's relay (`k8s/mountd/cmd/relay`)

A minimal authenticated splice on `NETD_STREAM_PORT` (10262), in every netd
pod. For each connection it reads one JSON auth line (`{token:
proxyAuthSecret, workspaceId}`, compared in constant time), finds that
workspace's socket directory among the pods on its node, opens its
`ingress.sock` by descriptor, writes streamd's port as two bytes and
splices. Everything after the auth line passes through untouched, so the
protocol is end-to-end between server and streamd.

Errors for a single stream (unknown workspace, ingress dial failed) get an
`{ok:false}` line before the close. The server treats a silent close as a
dead peer, so a probe of a stale workspace must not look like one. Only a
bad auth line closes silently. Everything before the splice has a
deadline.

### Server transport (`drivers/k8s/substrate/stream-relay.ts`)

`relayDial` opens the TCP connection and sends both handshake lines in one
write. The address is the netd pod on the node of the workspace's pod, both
read from the server's informers (the workspace pod cache and a watch of
netd's pods), so a dial lists nothing. The server is a pod in the install
namespace (docs/server-in-cluster.md), and netd's ingress policy admits the
server's pods on the stream port. A workspace whose pod has no node yet, or
whose node has no running netd, fails with `RelayDialError`.

Streams share nothing. Each dial is its own TCP connection, so a failure
affects only its own caller, not other terminals, status streams or
forwarded ports. A caller's command timeout has a floor (5s) before the
dial deadline is derived from it: a probe that wants a fast answer should
not make a slow but healthy dial look like a dead relay.

Adapters give each consumer the interface it already used:
`dialCtrlStream` (child-process-shaped, for the status watcher),
`dialPtyStream` (PTY-shaped, for the terminal bridge), and `podExec` (the
one-shot runner behind tmux probes, shell create and kill, the changes diff
and similar).

## The browser hop

The slowest link is usually the first one. A remote install serves the
server straight over Tailscale (docs/remote-hosting.md), so the
browser↔server WebSocket is the whole WAN path. Three things keep it cheap:

- **Compression.** Every WebSocket negotiates `permessage-deflate`
  (`server-run.ts`) with a 512-byte threshold, so small latency-critical
  frames (a keystroke, its echo, a control frame) skip compression. Large
  ANSI repaints and snapshot/ACP JSON benefit.
  `test/api/websocket-compression.test.ts` checks the negotiation so a
  dependency bump cannot silently drop it. The
  `/events` hub sends on the raw `ws` socket rather than Hono's
  `WSContext`, because the context passes `compress: undefined`, which
  overrides ws's default and would leave the largest payload uncompressed.
- **No Nagle.** Every relay socket sets `setNoDelay`: the server's dial,
  the relay's TCP side (Go's default), and streamd's accepted and target
  sockets. The batchers already coalesce; Nagle on top would only add
  delay.
- **Keystroke batching.** The browser batches input with the same shared
  batcher on a 4ms window. A single keypress is sent at once; key repeat,
  a paste delivered in pieces, and a TUI's mouse reports stop costing one
  WebSocket frame and TLS record each.

## Failure model

When the relay is unreachable (the node's netd pod restarting, streamd
dead), streams fail and are retried by the existing layers: the status watcher's backoff
respawn, the frontend's WebSocket reconnect, and per-connection forward
errors.

Probe results are classified conservatively. Only a stream that reached the
pod and saw the command exit nonzero (`WorkspaceExecError`) counts as a real
answer. Any transport failure (`RelayDialError`) is `unknown`, and the
stale reaper treats `unknown` as "do not reap". A netd outage therefore
degrades terminals but never ends workspaces. A restart of one node's netd
pod drops that node's streams alone, which reconnect.

A stream can also die without either end seeing a close. An ACP
conversation's stream can sit idle for days, and the
cluster's connection tracking forgets an idle flow, after which one end's close never reaches the other.
So every relay socket (the server's dial and the relay's TCP side) turns on
TCP keepalive after a minute idle, which keeps the flow
known and closes a stream whose peer is gone. The ACP driver also drops a
conversation whose tmux window's process changed, without waiting for its
stream to close (docs/agent-modes.md).

The status watcher restarts streamd itself: after every third consecutive
stream failure it re-runs the boot command through `kubectl exec`
(`bootStreamd`), since that works when no stream does.

## Network policy

A workspace pod has no network interface, so it needs no ingress lock:
nothing can dial it, and the only way in is `ingress.sock`, which only the
relay reaches. netd's ingress policy (`buildNetdIngressNpManifest`) admits
the server's pods on the stream port.
