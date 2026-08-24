# Stream relay: worktree streams off the apiserver

Every steady-state byte between the server and a worktree pod — terminal
PTYs, the status watcher's tmux control stream, forwarded TCP, and
one-shot pod commands — rides plain TCP through the proxy pod into an
in-pod daemon, entirely off the apiserver. Worktree-create provisioning
rides it too: the pod's postStart hook (`worktree-bin/yaac-worktree-init`)
starts streamd before the container reports Ready, so every setup command
the server still runs (worktree gitdir rewrite, branch upstream, init
windows + agent respawn) is a relay exec. Claiming a prewarmed spare rides
it the same way — the claim gates on `waitForStreamd` before its first
mutation, then re-branches, retools, and re-applies the git identity over
the relay. `kubectl exec` survives only where no stream can be gated on:
the streamd self-heal re-boot, the teardown-time image-salvage survey, and
non-worktree infra pods. Before the relay, each
of these paths held a kubectl child per stream (or per TCP connection),
and every chunk crossed pod → containerd shim → kubelet → apiserver →
kubectl → server — with gVisor making the pod side extra expensive.

## Architecture

```
browser ── WS ── server ──(A)── proxy pod ──(B)── worktree pod
                             relay listener :10260   streamd :10300
                             (auth + splice)         (pty/ctrl/exec/tcp)

server = a pod of the install namespace, dialing the proxy's Service
```

### streamd (`dockerfiles/streamd/`)

A small plain-JS Node daemon baked into the base image at
`/opt/yaac/streamd` (with a prebuilt `@lydell/node-pty`), started last by
the pod's postStart setup script (`setsid node … &`, reparented to the
container init) — so a successful relay exec also proves the setup that
precedes it (git config, tmux server) is in place. Its source is part of the base image's content hash, so
editing it retags the image. It listens on `0.0.0.0:10300` — in gVisor
that is the sentry netstack, reachable via the pod IP like any Service
backend. Every connection opens with one JSON handshake line
(`{token, kind, …params}`) answered by one `{ok}` reply line:

- `tcp {port}` — raw splice to `localhost:<port>` in-pod. The in-pod dial
  is the point: localhost-bound dev servers stay reachable, which a
  proxy-side dial of `podIP:port` could not do.
- `ctrl {cmd}` — spawn argv with piped stdio, raw stdin/stdout splice
  (tmux control mode is a line protocol). Socket close ⇔ process kill.
  Also carries ACP: a worktree in `acp` mode dials `socat -
  UNIX-CONNECT:/tmp/yaac-acp/<window>.sock` here, and the JSON-RPC rides the
  same raw duplex. Note the socket-close semantics — which is exactly why the
  ACP agent is supervised by acpd inside a tmux window rather than being this
  stream's child (see docs/agent-modes.md).
- `exec {cmd}` — one-shot: run argv, reply with a single JSON line
  `{exitCode, stdout, stderr}` (bounded) and close. The `containerExec`
  replacement for worktree pods (`podExec`).
- `pty {cmd, cols, rows}` — spawn argv under a PTY. Framed both ways
  (`[1B type][4B BE length][payload]`, codec mirrored in
  `@yaac/shared/stream-frames`): data/resize/signal in, data/exit out.
  Resize frames drive TIOCSWINSZ; output is paused against socket
  backpressure (node-pty has no pull API). Output is micro-batched
  (leading edge immediate, then one frame per ~8ms window, size-capped):
  a tmux redraw burst reaches the browser as one message it can paint
  atomically — fewer frames on every hop, no cursor flicker from
  painting redraw fragments — while a lone keystroke echo pays no added
  latency. The server-side pty adapter likewise dispatches consecutive
  data frames from one chunk as a single callback (one WS message), and
  `bridge()` runs the same batcher once more before the socket
  (`@yaac/shared/batcher`, of which streamd's copy is the in-pod mirror)
  — which is what gives the containerless driver, whose host PTY reaches
  the bridge event by event with no streamd in front of it, the same
  coalescing.
- `ports {}` — push the pod's localhost-reachable LISTEN ports (parsed
  in-pod from `/proc/net/tcp{,6}`, bounded, loopback/wildcard binds
  only, streamd's own port excluded) as JSON lines: once on connect, on
  every change, and re-sent as a keepalive. Feeds the server's
  port detector (docs/auto-forward-ports.md); the poll only runs while
  a ports stream is open.

The handshake token is per-worktree — `HMAC-SHA256(proxyAuthSecret,
worktreeId)`, derived (never stored), injected as `YAAC_STREAM_TOKEN` at
create. It is defense in depth alongside the ingress NetworkPolicies: a worktree
leaking its own token gains nothing, since only its own daemon accepts it
and only the proxy can reach any daemon.

### Proxy relay listener (`k8s/proxy/proxy.ts`)

A dumb authenticated CONNECT on `:10260`, present in every proxy. Per
connection: read one JSON auth line (`{token: proxyAuthSecret,
worktreeId}`, timing-safe compare), resolve the worktree's pod IP from the
pod-watch reverse index (labelSelector list on a miss), dial
`podIP:10300`, splice. Everything after the auth line — the streamd
handshake, its reply, the payload — flows through untouched, so the
protocol stays end-to-end server↔streamd. Per-stream failures (unknown
worktree, pod dial failure) are answered with an `{ok:false}` line before
closing — the server reads a silent close as a dead peer, so a stale
worktree's probe must not masquerade as one; only a bad auth line closes
silently.

Nor may anything before the splice hang instead of answering. A worktree
pod whose ingress policy has not yet admitted the proxy *drops* the SYN,
so an unbounded `net.connect` would sit out the OS retry series holding
both sockets while the server learns nothing; a deadline over the whole
pre-splice phase — auth line, IP resolve, pod dial — makes that an
ordinary refusal instead.

### Server transport (`drivers/k8s/substrate/stream-relay.ts`)

`relayDial` opens the TCP connection and pipelines both handshake lines.
The address is the proxy's Service —
`yaac-proxy.<namespace>.svc.cluster.local:10260` — dialed directly, because
the server is a pod of that namespace (docs/server-in-cluster.md) and the
proxy's ingress policy admits its pod selector on the relay port.
`YAAC_RELAY_ADDR` is what the Deployment states it as, and it is honoured
verbatim, so an install that puts the proxy somewhere else says so there
rather than in code.

Nothing is shared between streams, which is what makes failure handling
trivial: every dial is its own TCP connection to a Service, so a failed one
fails its own caller and leaves every other terminal, status stream and
forwarded port untouched. One rule still guards against impatience, though:
a caller's command budget is floored before the dial deadline is derived
from it, because how fast one probe wants an answer is not a statement about
how long a dial across the cluster legitimately takes.

Adapters give each consumer the surface it already used, so the
respawn/backoff, `bridge()`, forwarder-registry, and frontend WS logic
are unchanged: `dialCtrlStream` (child-shaped, the status watcher's
`spawnAttach`), `dialPtyStream` (PtyLike, the terminal bridge), and
`podExec` (the one-shot command runner behind tmux probes, terminal
listing, view cleanup, status-right updates, the changes diff, and the
opencode probe).

## The browser hop

Everything above optimizes bytes inside the cluster, but the link that is
actually slow is usually the first one: a remote install is
`tailscale serve` straight to the server (docs/remote-hosting.md), so the
browser↔server WebSocket is the whole WAN path, with no edge tier in
front of it. Four things keep it cheap.

- **Compression.** `permessage-deflate` is negotiated on every WebSocket
  (`server-run.ts`), with a 512-byte threshold so the latency-critical
  small frames — a keystroke, its echo, a control frame — skip the codec
  entirely. What benefits is the bulk: ANSI-heavy repaints, and the
  snapshot and ACP JSON. `@hono/node-ws` builds its `WebSocketServer`
  with no options pass-through, so the option is set on the `wss` it
  returns; `ws` reads it per upgrade, which is what makes that work, and
  `test/api/websocket-compression.test.ts` asserts the negotiation so a
  dependency bump cannot silently drop it. For the same reason the
  `/events` hub holds the raw `ws` socket rather than Hono's `WSContext`:
  the context's `send` passes an explicit `undefined` compress flag,
  which overrides ws's own default and would leave the largest payload on
  the server uncompressed.
- **No Nagle.** Every relay socket sets `setNoDelay` — the server's dial,
  both legs of the proxy splice, streamd's accept and its TCP target.
  Coalescing here is the batchers' job, and they do it deliberately;
  leaving Nagle on top only spends their window in the kernel waiting for
  a companion write that the batcher already folded in.
- **Keystroke batching.** The browser coalesces input on a 4ms
  leading-edge window (the same shared batcher, half the output window):
  a lone keypress is never delayed, while autorepeat, a piecewise paste
  and a TUI's mouse reports stop costing one WebSocket frame and one TLS
  record each.
- **Link measurement.** The PTY control channel's `ping` carries a client
  stamp that the `pong` echoes back, so the webapp can time the round
  trip without tracking what is in flight; each open pane probes every
  10s and the samples land in one app-wide store
  (`frontend/src/lib/link-quality.ts`). A stamp-less ping — the CLI's
  keepalive — still gets the bare pong it expects.

## Failure model

When the relay is unreachable (proxy pod restarting, streamd dead),
streams fail and retry through the layers that already exist for exactly
this: the status watcher's backoff respawn, the frontend's WS reconnect,
per-connection forward errors. Probe classification is conservative: only
a stream that REACHED the pod and saw the command exit nonzero
(`RelayExecError`) is conclusive; every transport failure
(`RelayDialError`) is `unknown`, which the reaper treats as "do not
reap" — a proxy outage degrades terminals, never worktree lifetimes. The
status watcher self-heals streamd: every third consecutive stream death
it re-runs the boot exec (`bootStreamd`), the one steady-state kubectl
exec kept, because it is what works when no stream can.

## Network policy

The relay makes proxy→pod dialing real, so pod ingress is locked down
with it (before, nothing dialed worktree pods and their ingress was
default-allow by omission):

- Proxy ingress (`buildProxyIngressNpManifest`): the relay port is
  admitted from the node CIDRs (netd's Envoy, the kubelet probe) and from
  the SERVER's pod selector, which is how the server's own dials arrive
  now that it is a pod. Worktree pods match neither and cannot reach it.
- Worktree ingress lock (`buildWorktreeIngressLockNpManifest`): worktree
  pods accept only `app=yaac-proxy` on 10300, default-denying all other
  ingress.

## Compatibility edges

- Worktrees created before the upgrade have no streamd and an image
  without it — their terminals/status/forwards are dead after the server
  upgrade; restart the worktree. The reaper is unaffected (`unknown`
  probes don't reap; pod-informer evidence still drives cleanup).
- The proxy control API is a plain Service dial like the relay, on the
  proxy's own control port. Folding it onto the relay port is an open
  follow-up; nothing depends on the two being separate.
