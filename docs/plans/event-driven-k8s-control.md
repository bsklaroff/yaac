# Data-plane relay: session streams off the apiserver

## Context

The informer/reconciler layer (`docs/event-driven-reconcile.md`) removed
process-per-read and time-driven reconciliation. What remains is
**process-per-stream** — every byte of terminal output, status traffic,
and forwarded TCP still transits a dedicated kubectl child and the
apiserver:

- one persistent `kubectl exec … tmux -C attach` per running session
  (status watcher, `features/sessions/status-watcher.ts`),
- one `kubectl exec -it … tmux attach` under node-pty per open terminal
  tab (`features/terminals/pty-bridge.ts`),
- one `kubectl exec -i … nc localhost <port>` **per TCP connection** to a
  forwarded port (`platform/container/port.ts`),
- one `kubectl exec -i … socat` per control-API request burst to the
  proxy (`platform/k8s/exec-tunnel.ts` — despite the name it is not a
  mux: one child per accepted connection),
- plus the scattered one-shot `containerExec`s into session pods (tmux
  liveness probes, view kills, resize-window, status-right, terminal
  listing).

Each chunk crosses pod → containerd shim → kubelet → apiserver → kubectl
→ server; gVisor makes the pod side extra expensive. This plan replaces
all of it with **direct TCP through the proxy pod** and then **deletes
the kubectl stream paths** — the relay is the only steady-state way the
server touches a session pod, top-level and nested alike. kubectl exec
survives only where it was always going to: session-create provisioning
(the bounded setup execs that run before streamd exists) and non-session
infra pods (cilium agent, builder, image-promoter writer).

The hostPath-status stepping stone from the earlier draft is dropped:
status rides the relay as a plain stream kind, so one mechanism covers
status + PTYs + forwards + one-shot commands.

Facts the design leans on (verified in-tree):

- The proxy pod is trusted infra on runc, `replicas: 1, strategy:
  Recreate`, with a pod-watch index of `podIP → sessionId` and an
  ingress-lock CNP (`buildProxyIngressCnpManifest`). The **inner proxy
  in a vcluster runs the same image and code**, so it grows the relay
  listener for free — nested is the same mechanism, not a variant.
- A vcluster pod's `status.podIP` is its **host** IP (syncer
  write-back), so an inner proxy's pod-watch index already maps host
  IPs, and dialing them from the inner proxy is plain same-namespace
  pod-to-pod traffic.
- The per-session vcluster NetworkPolicy
  (`buildVclusterSessionNetworkPolicyManifest`) admits the session pod
  to its synced pods on **all ports** — the nested server can dial its
  inner proxy's relay port with no egress change.
- Session pods have **no ingress policy today** (Cilium default-allow) —
  nothing dials them, but nothing forbids it either. The relay makes
  proxy→pod dialing real, so an ingress lock ships with it.
- The base image (`dockerfiles/Dockerfile.default`) guarantees Node 22
  and tmux in every session pod (top-level and nested project chains
  both layer on it), and yaac owns that image — the in-pod side is a
  Node daemon with a prebuilt PTY module baked in.
- All three server stream paths already have injectable factory seams
  (`StatusWatcherDeps.spawnAttach`, `spawnAttachPty`, `RelayFactory`),
  so the relay lands behind them; the surrounding logic
  (respawn/backoff, `bridge()`, forwarder registry, frontend WS
  protocol) does not change, and the kubectl implementations behind
  those seams are deleted at the end.

## Architecture

```
browser ── WS ── server ──(A)── proxy pod ──(B)── session pod
                             relay listener :10260   streamd :10300
                             (auth + splice)         (pty/ctrl/tcp)

top-level:  server = host process,   proxy = install proxy (hostPort)
nested:     server = session pod,    proxy = inner proxy (pod IP dial)
```

Same three components on both levels; only hop A's addressing differs.

### 1. `streamd` — in-pod stream daemon

A small Node program baked into the base image (source in
`dockerfiles/streamd/`, so `contextHash()` rebuilds the image when it
changes; dev-only files listed in `.containerignore`). Installed at
`/opt/yaac/streamd` with `@lydell/node-pty` (prebuilt binaries — no
compiler in the image). Started by session-create's existing setup exec
(the same step that boots the tmux server): `setsid node
/opt/yaac/streamd/main.js &`. Prewarmed spares boot it too (same path).
Inner session pods get it identically — the inner install's image chain
layers on the same base, and the inner server's create path runs the
same setup.

Listens on `0.0.0.0:POD_STREAM_PORT` (10300) — in gVisor that is the
sentry netstack, reachable via the pod IP like any Service backend.
Every connection starts with one JSON handshake line:

```
{"token": "<streamToken>", "kind": "pty"|"ctrl"|"tcp", ...params}
```

- `token` — per-session secret, `HMAC-SHA256(proxyAuthSecret,
  sessionId)`, where `proxyAuthSecret` is the dialing install's own
  proxy secret (outer for top-level sessions, inner for inner sessions).
  The server derives it (no new storage, survives restarts); the pod
  gets it as env `YAAC_STREAM_TOKEN` at create. A session leaking its
  own token gains nothing (the listener only reaches its own pod); it is
  defense in depth alongside the CNPs.
- reply: `{"ok":true}` line, or `{"ok":false,"error":…}` + close.

Stream kinds:

- `tcp` `{port}` — `net.connect(127.0.0.1, port)`, then raw byte splice
  (backpressure = socket piping). Replaces the per-connection `nc` exec;
  keeps today's semantics exactly (dial originates in-pod, so
  localhost-bound dev servers stay reachable — the reason the proxy
  cannot just dial `podIP:port` itself).
- `ctrl` `{cmd: [argv]}` — spawn argv with piped stdio, no TTY; splice
  stdin/stdout raw (tmux control mode is a line protocol; no framing
  needed). Socket close ⇔ process exit. Carries the status watcher's
  `tmux -S … -C attach-session -t yaac -f <flags>` unchanged, and —
  once the kubectl paths go — every one-shot session-pod command
  (`probeTmuxLiveness`, `killViewSession`, `sweepGhostViews`,
  status-right updates, terminal listing) as short-lived ctrl streams or
  commands on the session's registered control stream
  (`registerSessionControlStream` already prefers that).
- `pty` `{cmd: [argv], cols, rows}` — spawn argv under a node-pty PTY.
  Framed both ways: `[1B type][4B BE length][payload]` with types
  `0 data`, `1 resize {cols,rows}`, `2 signal {name}` (client→pod) and
  `0 data`, `3 exit {code}` (pod→client). This is the in-pod PTY the
  kubectl `-t` flag provided before; resize frames drive `TIOCSWINSZ` so
  clipping behavior matches today (tmux views stay `window-size manual`
  with out-of-band `resize-window` on the ctrl channel).

streamd enforces a small cap on concurrent streams and kills children
when their socket closes (the double-detach dance in `bridge()` keeps
working — `detach` still runs `kill-session` via the ctrl channel).

### 2. Proxy relay listener

A new `net` listener in `k8s/proxy/proxy.ts` on `RELAY_PORT` (10260) —
present in every proxy, outer and inner, since they share the image.
Per connection: read one JSON line `{"token": "<proxyAuthSecret>",
"sessionId": "<sid>"}` (timing-safe compare, same as the control API);
resolve `sessionId → podIP` from the pod-watch index (add the reverse
map next to `podIP → sessionId`; on miss, the existing labelSelector
list is the fallback); dial `podIP:POD_STREAM_PORT`; then splice bytes
both ways. Everything after the first line — the streamd handshake, its
reply, the payload — flows through untouched, so the relay stays a dumb
authenticated CONNECT and the protocol is end-to-end server↔streamd.
An inner proxy's pod-watch runs against its vcluster apiserver and
yields host pod IPs (write-back), so the same code resolves and dials
inner session pods with zero nesting branches.

### 3. Server transport + factory swap

`platform/k8s/stream-relay.ts` (new): `relayDial(sessionId, handshake)`
opens a TCP connection to the relay, runs both handshake lines, returns
the socket. Relay address resolution, cached per server run and
re-resolved on failure:

1. `env.relayAddr` (`YAAC_RELAY_ADDR`) — explicit override.
2. Nested (`YAAC_NESTED=1`): the inner proxy's pod IP, read from the
   vcluster apiserver (the informer layer or a one-shot get on the
   `yaac-proxy` deployment's pod). The dial is admitted by the existing
   all-ports synced-pod egress rule.
3. Top-level: `127.0.0.1:RELAY_PORT` — the proxy Deployment exposes the
   relay port as a `hostPort` bound to `127.0.0.1` where the server
   host is the node, and kind clusters map it to host loopback with a
   kind `extraPortMapping` (added to `k8s/kind-config.yaml`; `yaac
   cluster check` learns to detect a cluster missing the mapping and
   direct the user to re-run `yaac cluster setup` — kind cannot add
   mappings to a live cluster). Node-container-IP dialing is the
   detection-time fallback probe on Linux kind hosts that predate the
   mapping.

Adapters, one per seam, each implementing an interface the consumer
already depends on — the consumers do not change:

| Seam | Adapter | Consumer untouched |
|---|---|---|
| `StatusWatcherDeps.spawnAttach` | `ctrl` stream → `AttachChild` | status-watcher init/heartbeat/backoff |
| `spawnAttachPty` (`PtyLike`) | `pty` stream → `PtyLike` (write/resize/kill/onData/onExit) | `bridge()`, frontend WS protocol |
| `RelayFactory` (port.ts) | `tcp` stream → child-shaped `{stdout, stdin, kill}` | `startPortForwarders`, forwarder registry |
| session-pod `containerExec` call sites | `ctrl` stream (or the registered control stream) | probe/cleanup/tmux-command logic |

The kubectl implementations behind the first three seams
(`spawnKubectlAttach`, kubectl-under-node-pty, `kubectlRelay`) are
**deleted** once the relay path has e2e coverage on both levels — they
are not a permanent fallback. When the relay is unreachable (proxy pod
restarting, streamd died), streams fail and retry through the layers
that already exist for exactly this: the status watcher's backoff
respawn, the frontend's WS reconnect, per-connection forward errors.
`probeTmuxLiveness` over a dead relay yields `unknown`, which the reaper
already treats as "do not reap" — so a proxy outage degrades terminals,
never session lifetimes. The proxy thereby becomes availability-critical
for streams the way it already is for egress; `ensureRunning()` remains
the heal path.

The proxy control API (ExecTunnel) and the inner install's equivalent
can move onto the same relay port once this lands — noted as a
follow-up, not in scope.

## Network policy changes

Top-level (applied with `ensureProxyResources`):

- **Proxy ingress lock** (`buildProxyIngressCnpManifest`): add
  `RELAY_PORT` to the host-only rule — hostPort traffic arrives with
  host identity, and the server is the only legitimate relay client.
  Session pods must not reach the relay port (bearer + CNP).
- **New session ingress lock** (`buildSessionIngressLockCnpManifest`):
  selects `yaac.session-id` Exists in the install namespace; allows
  ingress to `POD_STREAM_PORT` from `app=yaac-proxy` endpoints only,
  default-denying everything else. Today session-pod ingress is wide
  open — a hardening win the relay forces us to cash in. Verified safe:
  nothing else dials session pods (no Services, no probes), and synced
  inner pods live in vcluster namespaces, outside this namespaced CNP.

Nested (projected per-vcluster by the outer server, alongside the
existing inner-redirect objects — the inner install has no host RBAC):

- **Inner proxy ingress lock** (`buildInnerProxyIngressCnpManifest`):
  add `RELAY_PORT` reachable from the **owning outer session pod only**
  (fromEndpoints `yaac.session-id=<owner>` in the install namespace) —
  the nested server is that pod. Other sessions' pods stay locked out.
- **Inner session ingress lock** (new projected CNP per vcluster
  namespace): synced session pods accept `POD_STREAM_PORT` from their
  own vcluster's inner proxy only. Same projection lifecycle as the
  inner-redirect CEC/CNPs (event-driven via vcluster-services deltas,
  pruned with the namespace).
- Egress needs nothing: nested-server→inner-proxy rides the existing
  all-ports synced-pod rule; inner-proxy→synced-pod is same-namespace
  traffic not selected by the redirect CNPs (they exclude proxies).

As with the inner-redirect projection, a nested install only streams
when the **outer** yaac is new enough to project these rules — the
established precedent (an outdated host yaac already breaks nested
egress; `yaac cluster check` inside the session is the diagnostic).

## Compatibility

No dual-stack steady state, so the cutover has sharp edges, accepted
deliberately:

- **Sessions created before the upgrade** have no streamd and an image
  without `/opt/yaac/streamd` — terminals/status/forwards for them are
  dead after the server upgrade; restart the session. The reaper is
  unaffected (`unknown` probes don't reap; pod-informer evidence still
  drives cleanup of genuinely dead pods).
- **kind clusters** predating the relay `extraPortMapping` need `yaac
  cluster setup` re-run (cluster recreate); `yaac cluster check` gains
  the detection + message. Linux hosts get a grace path via
  node-container-IP dialing; macOS does not (docker VM), which is
  acceptable — remote-hosting/moving-off-kind is the trajectory.
- **Nested** requires the outer install upgraded first (projection), the
  same ordering contract inner egress already has.

## Phases

1. **streamd, inert.** `dockerfiles/streamd/` (daemon + framing codec as
   plain JS, unit-tested in-process — it is just a TCP server),
   base-image install, `YAAC_STREAM_TOKEN` + boot step in
   session-create, `POD_STREAM_PORT`/`RELAY_PORT` constants, top-level
   CNP changes. Nothing dials it yet; e2e asserts the daemon answers a
   handshake (exec + localhost) and the ingress lock blocks a non-proxy
   pod.
2. **Relay + transport + all three stream kinds, top-level.** Proxy
   relay listener + reverse index + hostPort + kind mapping; server
   `stream-relay.ts`; adapters land behind the three seams with the
   kubectl implementations still present (transitional, for bisection —
   not shipped as a fallback mode). Existing forward/PTY/status e2e must
   pass with the relay forced on.
3. **Nested.** Inner-proxy address resolution, projected inner ingress
   locks, `yaac cluster check` additions; the nested session-create e2e
   family exercises streams end-to-end through the inner proxy.
4. **Delete the kubectl stream paths.** Remove `spawnKubectlAttach`,
   the kubectl node-pty spawn, `kubectlRelay`, and migrate session-pod
   one-shot `containerExec` call sites onto ctrl streams; `exec.ts`
   keeps only what provisioning and non-session infra use. Fold the
   shipped design into the `docs/` reference; fix the stale
   per-pod-relay comment block in `k8s/proxy/proxy.ts` (~line 2539) and
   the vestigial `dist/k8s/relay` rm in the root build script; decide
   the control-API-over-relay follow-up.

## Verification

- Unit: framing codec round-trips (incl. partial reads), handshake
  parse/auth, each adapter against an in-process streamd, relay listener
  against a fake pod socket (k8s/proxy tests).
- E2e: phase gates above; plus "zero kubectl children during an active
  terminal + forward + status stream" asserted via `ps` in the suite —
  the measurable claim of this plan — and the nested equivalent asserted
  inside the session pod.
- Manual: two sessions, two terminals each + a forwarded dev server;
  compare context-switch volume and apiserver CPU against the kubectl
  path; type-latency sanity over the relay.

## Open questions

- Frame cap and flow control for `pty` streams: node-pty has no pull
  API; pause the socket when `write()` buffers, resume on drain — needs
  a test with a flooding child (`yes`).
- Does the `ctrl` stream need a stderr channel? kubectl folded stderr
  into a log tail; streamd could append a trailing JSON line on nonzero
  exit instead. Decide during phase 2 by what status-watcher and probe
  classification actually need — `classifyTmuxProbeError` currently
  reads kubectl-shaped stderr and must be re-based on streamd's exit
  reporting.
- streamd crash: relay dial fails and consumers back off — should the
  status watcher's respawn also re-exec streamd via a create-style
  kubectl exec (self-heal, the one steady-state kubectl use that would
  remain), or is "broken until session restart" acceptable? Leaning
  self-heal: it is ~10 lines and bounds the blast radius of a streamd
  bug.
- Handshake/dial timeouts and the relay's concurrent-stream cap per
  session (a runaway page opening hundreds of terminals should fail
  fast, not wedge the proxy).
