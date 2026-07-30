# Stream relay: session streams off the apiserver

Every steady-state byte between the server and a session pod — terminal
PTYs, the status watcher's tmux control stream, forwarded TCP, and
one-shot pod commands — rides plain TCP through the proxy pod into an
in-pod daemon, entirely off the apiserver. Session-create provisioning
rides it too: the pod's postStart hook (`session-bin/yaac-session-init`)
starts streamd before the container reports Ready, so every setup command
the server still runs (worktree gitdir rewrite, branch upstream, init
windows + agent respawn) is a relay exec. `kubectl exec` survives only
where no stream can exist: the streamd self-heal re-boot, claim-time
retool/rebranch prep, and non-session infra pods. Before the relay, each
of these paths held a kubectl child per stream (or per TCP connection),
and every chunk crossed pod → containerd shim → kubelet → apiserver →
kubectl → server — with gVisor making the pod side extra expensive.

## Architecture

```
browser ── WS ── server ──(A)── proxy pod ──(B)── session pod
                             relay listener :10260   streamd :10300
                             (auth + splice)         (pty/ctrl/exec/tcp)

top-level:  server = host process,   proxy via one kubectl port-forward
nested:     server = session pod,    proxy = inner proxy (pod-IP dial)
```

Same three components on both levels; only hop A's addressing differs.
The inner proxy runs the same image and code as the outer one, so nested
sessions get the relay with no extra branch: its pod-watch runs against
the vcluster apiserver, whose synced pods carry **host** pod IPs (syncer
write-back), so the same resolve-and-dial serves inner session pods.

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
- `exec {cmd}` — one-shot: run argv, reply with a single JSON line
  `{exitCode, stdout, stderr}` (bounded) and close. The `containerExec`
  replacement for session pods (`sessionExec`).
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
  data frames from one chunk as a single callback (one WS message).

The handshake token is per-session — `HMAC-SHA256(proxyAuthSecret,
sessionId)`, derived (never stored), injected as `YAAC_STREAM_TOKEN` at
create. It is defense in depth alongside the ingress NetworkPolicies: a session
leaking its own token gains nothing, since only its own daemon accepts it
and only the proxy can reach any daemon.

### Proxy relay listener (`k8s/proxy/proxy.ts`)

A dumb authenticated CONNECT on `:10260`, present in every proxy. Per
connection: read one JSON auth line (`{token: proxyAuthSecret,
sessionId}`, timing-safe compare), resolve the session's pod IP from the
pod-watch reverse index (labelSelector list on a miss), dial
`podIP:10300`, splice. Everything after the auth line — the streamd
handshake, its reply, the payload — flows through untouched, so the
protocol stays end-to-end server↔streamd. Per-stream refusals (unknown
session, pod dial failure) are answered with an `{ok:false}` line before
closing — the server reads a silent close as a dead transport and
re-establishes its shared port-forward, so a stale session's probe must
not masquerade as one; only a bad auth line closes silently.

### Server transport (`platform/k8s/stream-relay.ts`)

`relayDial` opens the TCP connection and pipelines both handshake lines.
Address resolution, cached per run and re-resolved on transport failure:

1. `YAAC_RELAY_ADDR` — explicit override for hosts with a direct TCP
   route to the proxy pod (e.g. a server running on the cluster node),
   which skips the port-forward hop entirely.
2. Nested: the inner proxy's pod IP (from the vcluster apiserver), port
   10260 — plain pod-to-pod traffic admitted by the existing all-ports
   synced-pod egress rule.
3. Top-level: the local listener of ONE long-lived `kubectl
   port-forward` to the proxy Deployment, respawned on death. This
   deliberately keeps the proxy↔host hop on the apiserver: SPDY
   multiplexes every stream over the one connection (a new stream is a
   cheap stream-open, not an exec round trip), the per-byte cost is a
   few Go userspace copies on a loopback-local hop, and in exchange the
   host has zero listening ports, the kind config needs no port
   mappings, and there is no cluster-shape dependency at all. The wins
   the relay exists for — no kubectl child per stream, no
   per-connection exec setup, session-pod bytes leaving via netstack
   networking instead of the gVisor exec machinery — are unaffected by
   this hop. Port-forward works here because the proxy is a runc pod
   (CRI port-forward dials localhost in the pod netns, which a gVisor
   pod's netstack would not answer). A stream refused after a reply
   line leaves the shared forward alone; only a transport that never
   answers is torn down and re-resolved.

Adapters give each consumer the surface it already used, so the
respawn/backoff, `bridge()`, forwarder-registry, and frontend WS logic
are unchanged: `dialCtrlStream` (child-shaped, the status watcher's
`spawnAttach`), `dialPtyStream` (PtyLike, the terminal bridge),
`relayTcpFactory` (the port-forward RelayFactory), and `sessionExec`
(the one-shot command runner behind tmux probes, terminal listing, view
cleanup, status-right updates, the changes diff, and the opencode probe).

## Failure model

When the relay is unreachable (proxy pod restarting, streamd dead),
streams fail and retry through the layers that already exist for exactly
this: the status watcher's backoff respawn, the frontend's WS reconnect,
per-connection forward errors. Probe classification is conservative: only
a stream that REACHED the pod and saw the command exit nonzero
(`RelayExecError`) is conclusive; every transport failure
(`RelayDialError`) is `unknown`, which the reaper treats as "do not
reap" — a proxy outage degrades terminals, never session lifetimes. The
status watcher self-heals streamd: every third consecutive stream death
it re-runs the boot exec (`bootStreamd`), the one steady-state kubectl
exec kept, because it is what works when no stream can.

## Network policy

The relay makes proxy→pod dialing real, so pod ingress is locked down
with it (before, nothing dialed session pods and their ingress was
default-allow by omission):

- Proxy ingress (`buildProxyIngressNpManifest`): the relay port rides
  the host-only rule. The server's own dials arrive via port-forward —
  CRI dials localhost inside the pod netns, never traversing policy —
  so the network-side allowance exists for host-identity dials only
  (the YAAC_RELAY_ADDR node-local case); session pods cannot reach it.
- Session ingress lock (`buildSessionIngressLockNpManifest`): session
  pods accept only `app=yaac-proxy` on 10300, default-denying all other
  ingress.
- Nested, applied by the OUTER server into the vcluster's host
  namespace (the inner install has no host RBAC): the inner proxy accepts
  the relay port from its OWNING session pod only
  (`buildInnerProxyIngressNpManifest`), and synced session pods accept
  10300 from their vcluster's inner proxies only
  (`buildInnerSessionIngressLockNpManifest`). As with inner egress, a
  nested install only streams when the outer yaac is new enough to
  project these rules; `yaac cluster check` inside the session is the
  diagnostic (its `relay` check dials the inner proxy).

## Compatibility edges

- Sessions created before the upgrade have no streamd and an image
  without it — their terminals/status/forwards are dead after the server
  upgrade; restart the session. The reaper is unaffected (`unknown`
  probes don't reap; pod-informer evidence still drives cleanup).
- The proxy control API still rides its kubectl exec tunnel
  (`ExecTunnel`); moving it onto the relay port is an open follow-up.
