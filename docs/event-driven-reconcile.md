# Event-driven cluster control: informer caches + reconciler

The server consumes cluster state through watch-fed informer caches and
reconciles on events, not on a polling clock. Reads ride
`@kubernetes/client-node`; writes (`kubectlApply`/delete) and all streaming
(exec, PTYs, port-forward relays) stay on `kubectl`.

## Informer layer (`packages/server/src/platform/k8s/`)

`client.ts` holds lazy `KubeConfig`/`CoreV1Api`/`BatchV1Api` singletons.
`loadFromDefault()` resolves the same kubeconfig kubectl does (`KUBECONFIG`
env included), so the typed client and the kubectl write/exec paths always
address the same cluster — nested yaac's default context points at the
session's vcluster apiserver and needs nothing extra.

`informer-cache.ts` wraps one client-node informer per resource kind into
an `InformerCache<T>`: a mapped in-memory cache with `onChange`
notification, deduped by comparing the *mapped* object (an informer
`update` fires on every resourceVersion bump, most of which the mapped
types don't care about). client-node's `makeInformer` owns the watch
stream, resourceVersion tracking, and relist-on-410; the cache supervises
what the library deliberately does not (verified against the 1.4.0
source):

- On any non-410 error — a failed list included — the informer emits
  `error` and stops. The cache restarts it with exponential backoff
  (1s→30s, reset after 60s of uptime).
- There is no periodic resync, so a ghost row from an event lost while
  the watch was down would live forever. A 60s relist diff bounds it.
- The list path yields deserialized class instances (`Date` timestamps);
  the watch path yields raw JSON (ISO strings). The zod schemas behind
  every `mapItem` accept both (`z.union([z.string(), z.date()])`).
- `makeInformer`'s label selector applies to the watch query only — each
  `listFn` must apply the same selector itself.

`healthy()` means seeded and watch-connected: only then may a consumer
treat absence in the cache as absence in the cluster.

`cluster-cache.ts` is the registry of every informer the server runs,
exposed to the rest of the server as a set-active singleton (the display
path and reconcile steps read it; unit tests leave it null and fall back
to one-shot kubectl lists). Fixed informers: session pods (the
`sessionPodSelector` set), session Jobs, and vcluster namespaces. From
the namespaces cache it derives a dynamic pods+services informer pair per
live vcluster namespace — pods unselected (attribution needs every pod
IP), services selected by `vcluster.loft.sh/managed-by`. Deltas fan out
via `onDelta(source)` with sources `session-pods` / `session-jobs` /
`vcluster-namespaces` / `vcluster-pods` / `vcluster-services`.

`tick-snapshot.ts` keeps the per-pass point-in-time view: each getter
memoizes once per snapshot and answers from the active ClusterCache when
that source is healthy, else falls back to a live kubectl list. The
fallback is the destructive-step safety rule — the stale reaper and
vcluster GC never act on a cache known to be degraded, and both are
age-gated far beyond any watch lag.

## Reconciler (`packages/server/src/main/reconciler.ts`)

Steps subscribe to triggers; three lanes feed one serialized executor:

- **deltas** — informer events mark their sources dirty; a pass runs
  after a 250ms debounce so event storms coalesce. This is what makes
  vcluster attribution and inner-redirect projection land within
  milliseconds of the pod/service appearing.
- **poll (5s)** — for state no watch can see: the proxy's queued spawn
  requests (local HTTP), due cron schedules (DB + clock), and in-pod tmux
  death (the stale reaper; probes short-circuit on healthy status-watcher
  streams and are TTL-cached, so this lane forks nothing).
- **resync (60s)** — marks every step: the safety net for a missed event
  and the driver for the internally-throttled hygiene steps (image
  prewarm/GC, salvage, tproxy GC, builder-pod GC). Snapshots carry a
  `resync` flag; inner-redirect uses it to bypass its desired-state memo
  and re-assert projections, healing external drift.

Passes never overlap (steps share module state) and run the canonical
step order; step errors are isolated; after each pass the event hub
publishes a state snapshot (deduped by serialized compare). Idle cost is
the poll lane's cache reads plus one proxy HTTP call and one DB query —
no kubectl forks.

The server also reacts to `session-pods` deltas outside the reconciler:
syncing the per-session status watchers and firing the debounced
sessions-changed push (`main/server-run.ts`).

## Why writes and streams stay on kubectl

The write path is provisioning-heavy and a poor fit for the library: most
applies are Cilium custom resources and the CRDs themselves, where
kubectl's fresh per-invocation discovery sidesteps the CRD-then-CR "no
matches for kind" race that client-node's cached discovery hits; deletes
lean on kubectl-only ergonomics (multi-kind label-selector deletes,
`--ignore-not-found`, cascade defaults). Exec/PTY/port-forward streams
are not library calls at all. The transient-retry layer
(`retryTransient`, `platform/k8s/kubectl.ts`) matches kubectl stderr
strings and stays with those paths; one-shot reads that migrate to the
typed client later need a typed-HTTP-error retry equivalent.

## Client version

`@kubernetes/client-node` is pinned `1.4.0` (generated from k8s 1.34,
one minor behind the 1.35-line cluster — inside both the client compat
matrix and k8s's n-2 skew policy; the informers touch only core/v1 +
batch/v1 list/watch, stable for many minors). Take the `undici`
transport major and the 1.35-generated models when both are stable, not
the 2.0 RC.
