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
   (tmux control-mode status watcher, `src/features/sessions/status-watcher.ts`), one per open
   terminal tab (`src/features/terminals/pty-bridge.ts`), one **per TCP connection** to a
   forwarded port (`src/platform/container/port.ts`), plus the proxy exec tunnel.
   Every byte of terminal output and forwarded traffic transits pod →
   containerd shim → kubelet → apiserver → kubectl → server: five hops of
   syscall/copy per chunk, a large share of the apiserver's ~0.1 core, and a
   big slice of the ~120k ctx-switches/sec observed. gVisor makes the exec
   path extra expensive on the pod side too.
3. **Time-driven reconciliation.** `src/main/background-loop.ts` re-derives "did
   anything change?" from listings and JSON.stringify comparisons on a 5s
   timer, doing state-proportional work when nothing happened. The 75ea94e
   throttles (image-prewarm 60s, inner-redirect 30s, attribution 15s) traded
   reconcile latency for CPU; this plan removes that trade instead of tuning
   it.

Out of scope, tracked elsewhere: kubelet/cAdvisor housekeeping (fixed at
300s, `src/features/cluster/check.ts`), gVisor systrap cost inside session
pods (runtime tiering / `--platform=kvm` where available), and the ~60–75m
CPU + ~500MB each idle per-session vcluster control plane burns
(pause/lazy-start — its own plan when picked up).

## Design

Three moves, phased so each stands alone and ships with the old path as
fallback.

### 1. Informer layer: one watch-fed cache instead of kubectl-for-reads

This phase retires the repo-wide "no kubernetes client library" convention.
The revised rule (CLAUDE.md): use `@kubernetes/client-node` where a library
call applies, and `kubectl exec` where it doesn't. This phase cashes that in
for **reads**: the server consumes the apiserver directly through
`@kubernetes/client-node@1.4.0` (pinned `-E` in `packages/server`). Exec,
PTY, port-forward, and builder streams stay on `kubectl` for good.

Writes (`kubectlApply`/delete) also stay on `kubectl` — by design, not just
for this phase. The write path is provisioning-heavy and a poor fit for the
library: most applies are Cilium custom resources (CNP/CEC/CCEC) and the
CRDs themselves (`platform/k8s/cilium-crds.ts`), where kubectl's fresh per-invocation
discovery sidesteps the CRD-then-CR "no matches for kind" race that
client-node's cached `KubernetesObjectApi` discovery hits; and deletes lean
on kubectl-only ergonomics — multi-kind label-selector deletes (`kubectl
delete deployment,service,networkpolicy,ciliumnetworkpolicy,pod -l <sel>`,
`features/cluster/project-registry.ts:616`), `--ignore-not-found`, cascade defaults. Moving
them buys only warm-connection latency on rare create/cleanup ops while
adding a second error-classification path (exec keeps the stderr-matching
`retryTransient` forever). The one real robustness win — Server-Side Apply
field ownership — comes from `kubectl apply --server-side` without changing
transport; reach for that per-object if ever needed, not a wholesale
migration.

The old convention gave one auth path and one
failure vocabulary; the informer is the place that trade is clearly wrong —
the highest process-per-read cost center, read-only, and the library's
`makeInformer` is the exact machinery `src/platform/k8s/pod-watch.ts` hand-rolls
today.

- **Auth:** `KubeConfig.loadFromDefault()` reads the same kubeconfig kubectl
  uses — client-cert, token, and exec-credential plugins included — so
  dropping the kubectl child adds no cert handling of our own. The two
  provisioning calls that pass `--context` explicitly (`platform/k8s/gvisor.ts`,
  `features/cluster/setup.ts` Cilium install/status) are writes and stay on kubectl.
- **Informer:** `makeInformer(kc, path, listFn, labelSelector)` owns the
  watch stream, `resourceVersion` tracking, relist-on-410, and
  reconnect/backoff, emitting typed `add`/`update`/`delete`/`error` events.
  It replaces `PodWatcher`'s `createJsonStreamParser`, respawn/backoff, and
  60s reseed loop wholesale; the in-memory cache + `onChange` fan-out stay.
  Ships alongside the existing kubectl-`--watch` `PodWatcher` as the
  fallback until the informer is proven.

Maintain one informer per resource kind the server consumes: session pods
(replaces PodWatcher), session Jobs, vcluster namespaces, vcluster-namespace
pods and services (label-selector scoped). Change detection is the
informer's own event delta — no whole-object JSON.stringify.

`TickSnapshot` (`src/platform/k8s/tick-snapshot.ts`) keeps its interface but
reads the caches — the reconcile steps don't change. Remaining ad-hoc reads
migrate opportunistically onto typed client calls; writes
(`kubectlApply`/delete) stay on kubectl. Cost to carry: the transient-retry
layer (`retryTransient` + `TRANSIENT_KUBECTL_PATTERNS`, `platform/k8s/kubectl.ts:37`)
matches kubectl **stderr strings** — the informer's built-in reconnect
covers watches, but any one-shot read migrated off kubectl needs a parallel
typed-HTTP-error retry path.

### 2. Event-driven reconciler with slow resync

Invert `src/main/background-loop.ts`: each step subscribes to the informer
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
`features/sessions/reconcile/vcluster-attribution-reconcile.ts` / `features/sessions/reconcile/inner-redirect-reconcile.ts`
(blocked-then-outer-governed windows for fresh inner pods) collapse to the
debounce interval.

### 3. Data plane off the apiserver

The server already keeps one mux'd exec tunnel to the proxy pod
(`src/platform/k8s/exec-tunnel.ts`), and the proxy reaches every pod IP
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
   Adopts `@kubernetes/client-node` for reads (see move 1): **pin `1.4.0`** —
   `pnpm --filter @yaac/server add -E @kubernetes/client-node@1.4.0`.
   Remaining spike: the unit-test seam — `pod-watch.ts` tests inject a fake
   `WatchChild` today; under an informer they inject a fake informer or a
   stub `KubeConfig`/`Watch` instead.
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
  pointed at the vcluster API — it should, and client-node makes it a second
  `KubeConfig`/context rather than a second proxy child.
- RBAC: unchanged (same kubeconfig); the in-pod listener must bind pod-IP
  only and stay unreachable from other sessions (CNP, same pattern as the
  proxy ingress lock).
- e2e: per-run namespaces mean per-run informers; verify watch fan-out
  against the shared apiserver stays cheap with ~10 concurrent workers.
- client-node version (decided — pin `1.4.0`): `1.4.0` is the latest stable,
  generated from k8s **1.34**; the cluster runs the **1.35** line (vcluster
  apiserver `v1.35.0`, `k8s/vcluster/images.json`; host kind leaves
  `kindest/node`
  unpinned in `k8s/kind-config.yaml` → the kind binary default, ≥1.34 given
  the LimitedSwap kubelet config). So the client sits **one minor behind the
  server** — the `+` cell in client-node's compat matrix (cluster has newer
  features the client can't name; the shared surface works) and well inside
  k8s's n-2 skew policy. Harmless here: the informer only lists/watches
  pods/jobs/namespaces/services on core/v1 + batch/v1, stable for many
  minors. `2.0.0-rc.1` (npm `next` tag) is a **transport** major, not a k8s
  bump: it swaps the HTTP backend from `node-fetch` to `undici` (native
  fetch) — unconfirmed whether it advances the generated API past 1.34, and
  the major is driven by the transport break regardless. So 2.0 does not by
  itself close the 1.34→1.35 skew; that closes when a client-node minor
  generated from 1.35 ships (their policy: minor-per-k8s-minor). Stay on
  `1.4.0` now; take `undici` + the 1.35 models when both are stable, not the
  RC. The transitive-dep CVE surface is new upkeep the kubectl-only path did
  not carry.
