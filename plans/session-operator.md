# Session operator: declarative sessions with an in-cluster Go controller

## Context

Today the Node server is simultaneously the UX API, the data plane, and
the thing that makes the cluster match intent — where intent lives only in
that process's memory and the imperative call stacks of
`src/features/sessions/create.ts`. This plan moves the third role
in-cluster: a
`Session` custom resource becomes the persisted source of truth and a Go
controller (client-go/controller-runtime) converges the cluster to it.

Motivation is architectural, not CPU. The event-driven refactor
(`plans/event-driven-k8s-control.md`) already removes the polling and
process-per-stream overhead inside the current single-process design; an
operator is the *next* shape, and its trigger conditions are the plans
already on the shelf:

- **Remote hosting** (`plans/remote-server-hosting.md`): a server detached
  from the cluster needs convergence to happen cluster-side.
- **Multi-node** (`docs/multi-node-storage-plan.md`,
  `plans/moving-off-kind.md`): scheduling and healing across nodes wants a
  resident controller, not a laptop process.
- **Sessions governed while no server runs**: today reaping, kubeconfig
  heal, and prewarm maintenance stop when the server stops (sleep,
  upgrade, crash) and resume on restart.
- **Multiple writers**: CLI, desktop, web, and e2e harnesses funnel
  through the one server process as an implicit lock; CRs give optimistic
  concurrency with a single arbiter, and `kubectl get sessions` becomes a
  free debugging surface.

Do not start this plan until at least one trigger is committed. The
event-driven refactor is reusable groundwork either way — informer-shaped
code is exactly what a controller consumes.

## Domain model

`Session` (yaac.dev/v1alpha1), sketch:

```yaml
apiVersion: yaac.dev/v1alpha1
kind: Session
spec:
  project: my-app            # slug; resolves repo + data-dir paths
  tool: claude
  image: localhost:5000/yaac-my-app:abc123   # built host-side, referenced here
  branch: {base: main, agent: agent/<id>}
  nestedContainers: true
  virtualCluster: true
  prewarm: false
  initCommands: [...]
  memory: {requestBytes: ..., limitBytes: ...}
status:
  phase: Provisioning | Running | Waiting | Dead
  podName: ...
  deathCause: {reason: oom, detail: exit code 137}
  conditions:
    - {type: VclusterReady, ...}
    - {type: AgentStarted, ...}
    - {type: RedirectProjected, ...}
```

Likely a `Project` CR alongside it (prewarm pool size, image-chain state)
so the prewarm pool is declarative too. The vcluster, per-project
registry, salvage pods, and projected CEC/CNPs become **owned children**
of the Session rather than independently swept objects.

## Controller responsibilities

Converge spec → status per Session: ensure vcluster, ensure registry,
create the Job, run the tmux/agent bootstrap, watch the pod, stamp status
and death cause. Standard machinery replaces hand-rolled code:

- **ownerReferences / cascading GC** replace the orphan sweeps
  (`reconcileVclusters` GC, orphan-Job sweep, stuck-terminating sweeps and
  their grace-window reasoning).
- **Finalizers** replace ordered teardown (image salvage before the Job
  dies; registry hosts cleanup).
- **Per-object rate-limited workqueues** replace the tick throttles and
  their reconcile-latency tradeoffs; leader election and /metrics come
  free from controller-runtime.
- **Level-based reconciliation** deletes the half-provisioned-state
  cleanup class: a crash mid-create just means the next reconcile
  continues converging (the placeholder-pane zombie sweep in
  `reconcileStaleSessions` exists precisely because "tmux opened, agent
  never respawned" is reachable today).

## The server boundary

The Node server keeps what genuinely needs the host and shrinks to a
gateway for the rest:

- **Stays Node/host-side:** HTTP/WS for the frontend, terminals and port
  forwards (the phase-3 relay), git operations in project repos (hostPath
  + host credentials), podman image *builds* (host socket), the DB, title
  generation.
- **Moves in-cluster:** everything that is cluster-state convergence.
- **The create flow crosses the boundary:** server builds/pushes the
  image, writes a Session object referencing the tag and the mounted
  credential paths, then watches status. The controller consumes host-side
  *outputs*, never owns host resources.

Trust model carries over: the server is today the sole author of the
egress projections; that authorship moves to the controller and must stay
out of tenant reach. Spec becomes attack surface — validate with
CEL/ValidatingAdmissionPolicy (the hostPath-prefix VAP pattern already
used for vcluster synced pods).

## Costs

- Second language and build artifact. A Go controller image fits the
  existing `k8s/proxy` sidecar pattern (built/pushed to the local
  registry, mirrored for e2e in `test/global-setup.ts`).
- CRD versioning/migration discipline; heavier `yaac cluster setup`
  (CRDs + controller Deployment, `--repair` re-applies).
- e2e: per-run namespaces need either one shared controller serving all
  test namespaces or namespace-scoped controller instances per run
  (controller-runtime supports namespace-scoped caches). Decide early —
  it shapes the RBAC and the global setup.
- Debugging moves to `kubectl describe session` + controller logs +
  status conditions; the server log stops telling the whole story.
- Local single-user installs carry a resident controller pod (~tens of
  millicores idle; keep it lean, no webhooks unless VAP proves
  insufficient).

## Phases

1. **Shadow mode.** Define the Session CRD; the server writes it alongside
   the current imperative flow; a read-only controller observes and stamps
   status. No behavior change; validates the domain model against real
   lifecycles (including prewarm claim/re-brand, nested, vcluster).
2. **GC/teardown.** ownerReferences on vcluster namespace, registry,
   salvage pods, projections; finalizer for ordered teardown. Delete the
   corresponding sweeps from the background loop.
3. **Provisioning.** Controller owns Job creation and bootstrap; server's
   create path reduces to build + write CR + watch status.
4. **Gateway.** Server drops remaining cluster writes; all remaining
   host-side duties unchanged. CLI/desktop/e2e may now write CRs directly
   where useful.

## Open questions

- Bootstrap execs from the controller (tmux setup, agent respawn, nested
  podman service): exec-from-controller via the apiserver, or push into
  the pod entrypoint/an in-pod supervisor so the controller only creates
  the Job? The latter also serves the phase-3 relay's in-pod listener.
- Where prewarm *claiming* lives: claim mutates branch/upstream (host git)
  and retools the agent — likely a server-side action that patches spec,
  with the controller converging the retool.
- Does the inner-redirect/attribution projection move wholesale to the
  controller (it is pure cluster-state convergence, so it should)?
- CR namespace layout: one namespace per install (matches
  `YAAC_K8S_NAMESPACE` scoping today) vs cluster-scoped with install
  labels.
- Status → frontend latency: server informs on Session status (same
  informer layer as `plans/event-driven-k8s-control.md`) — verify the
  hub's 150ms coalesce still holds end-to-end.
