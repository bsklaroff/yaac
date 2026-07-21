# Event-driven Kubernetes control: retire polling and process-per-stream

## Context

Measured on an 8-core node with 4 sessions (July 2026, load 18–45): of the
control-plane overhead the server itself causes, the three structural cost
centers are

1. **Process-per-read.** Every piece of cluster truth arrives by forking
   kubectl (kubeconfig load, TLS handshake, JSON print). The 5s background
   loop spawned ~9 lists per tick before the TickSnapshot/throttle work
   (commit 75ea94e) cut it to ~3 plus throttled sweeps; one-off `kubectl
   get`s remain scattered through session create, cleanup, and vcluster ops.
2. **Process-per-stream.** One persistent `kubectl exec` per running session
   (tmux control-mode status watcher, `src/status-watcher.ts`), one per open
   terminal tab (`src/pty-bridge.ts`), one **per TCP connection** to a
   forwarded port (`src/lib/session/port.ts`), plus the proxy exec tunnel.
   Every byte of terminal output and forwarded traffic transits pod →
   containerd shim → kubelet → apiserver → kubectl → server: five hops of
   syscall/copy per chunk, a large share of the apiserver's ~0.1 core, and a
   big slice of the ~120k ctx-switches/sec observed. gVisor makes the exec
   path extra expensive on the pod side too.
3. **Time-driven reconciliation.** `src/background-loop.ts` re-derives "did
   anything change?" from listings and JSON.stringify comparisons on a 5s
   timer, doing state-proportional work when nothing happened. The 75ea94e
   throttles (image-prewarm 60s, inner-redirect 30s, attribution 15s) traded
   reconcile latency for CPU; this plan removes that trade instead of tuning
   it.

Out of scope, tracked elsewhere: kubelet/cAdvisor housekeeping (fixed at
300s, `src/lib/k8s/cluster-check.ts`), gVisor systrap cost inside session
pods (runtime tiering / `--platform=kvm` where available), and the ~60–75m
CPU + ~500MB each idle per-session vcluster control plane burns
(pause/lazy-start — its own plan when picked up).

## Design

Three moves, phased so each stands alone and ships with the old path as
fallback.

### 1. Informer layer: one watch-fed cache instead of kubectl-for-reads

The k8s API is plain HTTPS+JSON and `src/lib/k8s/pods.ts` already carries
zod schemas for the objects. Two candidate transports, both preserving the
"no kubernetes client library" convention:

- **`kubectl proxy` child (preferred spike):** one long-lived child owns
  auth/TLS; the server does REST against `127.0.0.1` with undici. Watches
  are chunked-JSON GETs — the incremental parser in
  `src/lib/k8s/pod-watch.ts` (`createJsonStreamParser`) already handles the
  framing.
- **Direct undici + kubeconfig:** no child at all, but the server takes on
  cert/exec-credential handling. Only worth it if the proxy child proves
  flaky.

Maintain watch-fed caches for the resource kinds the server consumes:
session pods (exists today as PodWatcher), session Jobs, vcluster
namespaces, vcluster-namespace pods and services (label-selector scoped).
Standard informer shape as PodWatcher already does it: watch for latency,
relist every 60s for truth. Change detection compares
`metadata.resourceVersion`, not whole-object JSON.stringify.

`TickSnapshot` (`src/lib/k8s/tick-snapshot.ts`) keeps its interface but
reads the caches — the reconcile steps don't change. Remaining ad-hoc reads
migrate opportunistically; writes (`kubectlApply`/delete) stay on kubectl
initially (rare enough not to matter) and can later become server-side
apply PATCHes on the same channel.

### 2. Event-driven reconciler with slow resync

Invert `src/background-loop.ts`: each step subscribes to the informer
deltas that concern it, debounced a few hundred ms, with a 60s full resync
pass as the safety net for missed events.

- pod/job deltas → stale reaper, prewarm pool, opencode capture
- vcluster namespace/service deltas → vcluster GC, inner redirects,
  attribution
- non-cluster sweeps (image prewarm, image GC, tproxy GC, builder-pod GC)
  → keep their internal throttles, driven off the resync tick

This deletes the 75ea94e throttle tradeoffs rather than tuning them: the
attribution map and inner-redirect projection fire within milliseconds of
the pod/service appearing — better latency than the original 5s loop —
while idle CPU approaches zero. The 15s/30s gaps documented in
`vcluster-attribution-reconcile.ts` / `inner-redirect-reconcile.ts`
(blocked-then-outer-governed windows for fresh inner pods) collapse to the
debounce interval.

### 3. Data plane off the apiserver

The server already keeps one mux'd exec tunnel to the proxy pod
(`src/lib/k8s/exec-tunnel.ts`), and the proxy reaches every pod IP
in-cluster. Generalize: one persistent connection from server to an
in-cluster relay that dials pod IPs directly and multiplexes

- terminal PTYs (replacing per-tab `kubectl exec -it tmux attach`),
- tmux control-mode status streams (replacing per-session watcher execs),
- port-forward connections (replacing per-connection `kubectl exec nc`).

Relay host: the proxy pod is the natural candidate (exists, already
session-adjacent, restart semantics understood); a purpose-built tiny
gateway on a hostPort is the alternative if coupling terminal traffic to
the egress proxy's lifecycle proves uncomfortable. Session pods run a small
in-pod listener bound to the pod IP, speaking to the existing tmux socket —
no more exec into gVisor for streams.

Cheaper stepping stone for status specifically: session dirs are already
hostPath-mounted, so the in-pod side can write status events to a file the
server watches with fs.watch — zero cluster machinery. This alone removes
the N persistent status-watcher execs and can ship before (and independent
of) the full relay.

## Expected effect

Server-caused control CPU (own process + apiserver/etcd share) drops from a
few hundred millicores under activity to low tens; context-switch volume
drops sharply (today every keystroke of every open terminal transits a
dedicated kubectl process); reconcile latency improves everywhere the
throttles made it worse. Does not touch gVisor sandbox cost or vcluster
baseline (see out-of-scope above).

## Phases

1. **Informer layer + event triggers** behind the existing step functions.
   Moderate effort, no wire-format or in-pod changes, deletes the polling.
   Spike question: `kubectl proxy` stability under long watches (it is the
   same client the current pod-watch child uses, so risk is low).
2. **Status via hostPath** — in-pod status writer + server fs.watch,
   removing the per-session exec stream. Falls back to the exec watcher
   where the mount is absent (nested/e2e variants).
3. **Data-plane relay** — in-pod listener, relay mux protocol, reconnect
   semantics, e2e coverage. Most invasive, biggest win for many sessions ×
   many open terminals. Decision gate: skip or defer if real workloads are
   mostly headless — phases 1–2 capture most of the value at a third of the
   effort.

## Open questions

- Relay transport/protocol: extend the exec-tunnel framing vs a boring
  WebSocket mux; how resize/signal control frames ride along
  (`pty-bridge.ts` already JSON-frames these).
- Whether nested yaac (vcluster apiserver) gets the same informer layer
  pointed at the vcluster API — it should, the transport is identical.
- RBAC: unchanged (same kubeconfig); the in-pod listener must bind pod-IP
  only and stay unreachable from other sessions (CNP, same pattern as the
  proxy ingress lock).
- e2e: per-run namespaces mean per-run informers; verify watch fan-out
  against the shared apiserver stays cheap with ~10 concurrent workers.
