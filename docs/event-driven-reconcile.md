# Event-driven reconcile

The server's reconcile loop runs when something changes, not on a polling
clock. Under the k8s driver, cluster state comes from watch-fed informer
caches. Reads and watches use `@kubernetes/client-node`. Writes
(`kubectlApply`, deletes) and bounded provisioning execs use `kubectl`.
Steady-state streams into a workspace pod (PTYs, status, port forwards,
one-shot commands) use the stream relay instead; see
[stream-relay.md](stream-relay.md).

## Reconciler (`main/reconciler.ts`)

Each reconcile step names the triggers that should run it. The step list is
`defaultReconcileSteps()` in `domain/reconcile.ts`, plus the steps the driver
adds. Two lanes mark the pass dirty, and one executor runs passes one at a
time:

- **Changes.** A trigger marks the pass dirty, and the pass runs after a
  250 ms debounce so a burst of events becomes one pass. The named triggers
  (`MEDIATOR_TRIGGERS` in `drivers/contract.ts`) are:
  - `workspaces` and `units`: a workspace, or the thing holding it, appeared
    or went away. Under k8s these are the workspace-pod and workspace-Job
    informers. Under containerless, the driver raises `workspaces` when a
    workspace's tmux server exits.
  - `live-agents`: a workspace's running conversations changed (one started,
    ended, learned its id, or switched model). An `acp` conversation learns
    its id in an in-pod handshake no cluster watch sees, so without this the
    chat pane would wait for the next resync.
  - `status-streams`: a status-watcher connection dropped. After that the
    server can no longer assume the workspace's tmux is alive, so the stale
    reaper probes it.

  A driver can also raise triggers of its own. The k8s driver raises
  `proxy-refreshed` (the egress proxy captured a rotated credential).
- **Resync (every 60 s).** Runs every step. It catches any missed event, and
  it is the clock for the timed steps. A step that sets `every` runs on a
  resync at most that often after its last successful run (registry and
  image GCs, the node-local sweep, the containerless credential sync), so a
  failed run retries on the next resync. The reconciler keeps that clock,
  with half a resync of slack, so no step throttles itself. The first
  pass after start is a resync. The k8s informers do not depend on it: each
  relists itself (below).

There is no poll lane: every source has an event, and the resync makes a
lost event cost latency rather than correctness. Passes never overlap,
because steps share module state. Steps run in list order. A step lets a
failed read reject rather than catching it, and the reconciler logs the
error and runs the remaining steps. Snapshots reach the
browser separately: every store the snapshot reads calls
`notifyWorkspaceListChanged()` when it changes, and `server-run.ts` rebuilds
and pushes the snapshot, coalescing bursts over 150 ms.

## k8s informer layer (`drivers/k8s/substrate/`)

`client.ts` loads the kubeconfig with `loadFromDefault()`, which reads the
same file kubectl does (including `KUBECONFIG`), so both talk to the same
cluster.

`informer-cache.ts` wraps one client-node informer in an `InformerCache<T>`,
an in-memory map of mapped objects. `onChange` fires only when a mapped object
changes, since most resourceVersion bumps touch fields the mapping drops.
client-node's `makeInformer` handles the watch stream, resourceVersion
tracking and relisting after a 410 (Gone). The cache adds what the library
leaves out (checked against client-node 1.4.0):

- On any other error, including a failed list, the informer emits `error`
  and stops. The cache restarts it with exponential backoff from 1 s to
  30 s, reset after 60 s of uptime.
- The library never resyncs, so an object whose delete event was lost while
  the watch was down would stay in the cache forever. The cache relists
  every 60 s and diffs.
- The list path returns class instances with `Date` timestamps. The watch
  path returns raw JSON with ISO strings. Every `mapItem` schema accepts
  both (`z.union([z.string(), z.date()])`).
- `makeInformer`'s label selector applies only to the watch. Each `listFn`
  must apply the same selector itself.

`healthy()` means the cache is seeded and its watch is connected. Only then
may a caller treat "not in the cache" as "not in the cluster".

`cluster-cache.ts` is the registry of every informer the server runs. It
watches workspace pods (`workspacePodSelector`), workspace Jobs, and the two
objects the egress proxy writes: its state ConfigMap (`proxy-state`) and its
captured credential rotations (`proxy-refreshed`). The k8s driver's
`lifecycle.ts` subscribes with `onDelta` and turns pod and Job deltas into the
`workspaces` and `units` triggers. A `proxy-state` delta only refreshes the
snapshot. The cache is also a process-wide singleton
(`setActiveClusterCache`) that the display path and steps read. It is null in
unit tests, which fall back to one-shot kubectl lists.

`tick-snapshot.ts` gives each pass one point-in-time view. Each getter is
memoized per pass. It answers from the cache when that informer is healthy,
and otherwise does a live kubectl list. That fallback is what keeps
destructive steps safe: the stale reaper never acts on a cache known to be
behind, and its slower sweeps wait far longer than any watch lag.

## Why writes and exec stay on kubectl

- `kubectl` runs API discovery fresh on every call. client-node caches it,
  which causes "no matches for kind" errors when a CRD and its first object
  are applied close together.
- Deletes use features only kubectl has: multi-kind deletes by label
  selector, `--ignore-not-found`, and its cascade defaults.
- Exec, PTY and port-forward streams are not library calls at all.

The retry layer for transient failures (`retryTransient` in
`substrate/kubectl.ts`) matches kubectl stderr text, so it only covers kubectl
calls. A read moved to the typed client needs its own retry on typed HTTP
errors.

## Client version

`@kubernetes/client-node` is pinned to `1.4.0` in the workspace catalog. It is
generated from Kubernetes 1.34, while `k8s/kind-config.yaml` pins the node
image to 1.37. That gap is safe here because the informers only list and watch
core/v1 and batch/v1, which have been stable for many releases. When
upgrading, prefer a stable release with the `undici` transport and newer
generated models over the 2.0 release candidate.
