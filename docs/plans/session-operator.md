# Session operator: declarative sessions with an in-cluster Go controller

## Context

Today the Node server is simultaneously the UX API, the data plane, and
the thing that makes the cluster match intent — where intent lives only in
that process's memory and the imperative call stacks of
`src/features/worktrees/create.ts`. This plan moves the third role
in-cluster: a
`Session` custom resource becomes the persisted source of truth and a Go
controller (client-go/controller-runtime) converges the cluster to it.

Motivation is architectural, not CPU. The event-driven control layer
(`docs/event-driven-reconcile.md`) already removes the polling overhead
inside the current single-process design, and
`docs/stream-relay.md` (shipped) covers the remaining
process-per-stream work; an operator is the *next* shape, and its
trigger conditions are the plans already on the shelf:

- **Remote hosting** (`docs/remote-hosting.md`): a server detached
  from the cluster needs convergence to happen cluster-side.
- **Multi-node** (`docs/plans/multi-node-storage-plan.md`,
  `docs/plans/moving-off-kind.md`): scheduling and healing across nodes wants a
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
  `reconcileStaleWorktrees` exists precisely because "tmux opened, agent
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
  informer layer as `docs/event-driven-reconcile.md`) — verify the
  hub's 150ms coalesce still holds end-to-end.

## Prior art: kubernetes-sigs/agent-sandbox

This plan predates [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox),
a SIG-Apps project whose stated purpose — "isolated, stateful, singleton
workloads, ideal for AI agent runtimes" — is nearly our exact use case. It
is not a toy: the API is already at `v1beta1` (`agents.x-k8s.io`), the
controller is controller-runtime-based with leader election, tracing, and
`/metrics`, and there are generated Go/Python clients plus warm-pool load
tests. Roughly, **it already is the generic half of this plan** (the
"controller responsibilities" and "GC/teardown machinery" sections), while
the yaac-domain half (vcluster, per-project registry, the netd egress
redirect, image salvage) has no counterpart in it. So the decision this
plan must add is *build-vs-adopt for the generic layer*, not just "write a
controller."

### What it provides

- **`Sandbox`** — one stateful **Pod** (not a Job) with a stable identity,
  an optional headless Service (`spec.service`), and `volumeClaimTemplates`.
  `spec.lifecycle` = `shutdownTime` + `shutdownPolicy: Delete|Retain` (TTL
  reaping). `spec.operatingMode: Running|Suspended`: **Suspended gracefully
  deletes the pod but retains PVCs and the Service**; Running reconstructs
  the pod from `spec.podTemplate` — *only when no pod exists by name*
  (verified in `controllers/sandbox_controller.go` `reconcilePod`: a pod
  that reached `Succeeded`/`Failed` is left in place and surfaced via a
  `Finished` condition, never resurrected). Status carries `conditions`
  (`Ready`/`Suspended`/`Finished`), `podIPs`, `nodeName`, `serviceFQDN`.
- **`SandboxTemplate`** — reusable pod spec, plus a managed `networkPolicy`
  with a `networkPolicyManagement: Managed|Unmanaged` switch.
- **`SandboxWarmPool`** (`replicas`, `sandboxTemplateRef`, `updateStrategy:
  Recreate|OnReplenish`) + **`SandboxClaim`** (checks out a pool sandbox;
  supports **claim-time `env` injection and `additionalPodMetadata`**, gated
  by template `envVarsInjectionPolicy`/`volumeClaimTemplatesPolicy`).
- **Snapshots** (memory/disk checkpoint-restore) exist but are a **GKE-only
  extension** (`>=1.35.2-gke`, gVisor) — *not portable to our local
  kind/gVisor cluster*. On our substrate we get suspend/resume
  (pod-delete + PVC-retain), not checkpoint hibernation.

### Implementation status (verified against `main`, not READMEs)

Read the actual source, since "AI agent sandbox" READMEs oversell. Every
capability this plan would lean on is **implemented and non-trivial**, not
KEP-stage vapor:

- **Suspend/resume** (`operatingMode`): implemented — KEP-694 status
  `implemented`; logic confirmed in `controllers/sandbox_controller.go`
  `reconcilePod` (Suspended deletes the pod keeping PVC+Service; Running
  recreates only when no pod exists by name).
- **TTL reaping** (`lifecycle.shutdownTime`): implemented —
  `checkSandboxExpiry`/`setSandboxExpiredCondition` in the reconcile loop.
- **Warm pool**: implemented — `extensions/controllers/sandboxwarmpool_controller.go`
  is a real replica reconciler (batched create/delete, `maxBatchSize`
  default 300, orphan adoption via ownerReferences, `readyReplicas`,
  `Recreate`/`OnReplenish` update strategy).
- **Claim / checkout-from-pool with env injection**: implemented — and the
  most mature piece (`sandboxclaim_controller.go` is ~88 KB): pool adoption
  with informer-cache-lag requeue handling, env-injection *with policy
  enforcement* (`ErrEnvVarsInjectionRejected`), `volumeClaimTemplates`
  policy gating, and a cross-namespace-adoption guard.
- **Template + managed NetworkPolicy**: implemented —
  `sandboxtemplate_controller.go` owns a `NetworkPolicy` per template.
- **Admission/webhook footprint (good news for `yaac cluster setup`)**: the
  controller runs a webhook server, but it is **conversion-focused**
  (v1alpha1↔v1beta1) and **self-manages its serving certs**
  (`--manage-webhook-certs=true` default, patches CRD `caBundle`s on
  startup) — **no cert-manager dependency**. It can be disabled with
  `--enable-webhook=false` at the cost of API-version conversion. Ships as
  plain manifests (`k8s/controller.yaml` + `k8s/extensions.yaml`) or a Helm
  chart, in namespace `agent-sandbox-system`.
- **Snapshots (checkpoint/restore): NOT implemented in this repo.** There is
  no Go snapshot controller and no snapshot CRD here — only site docs and a
  **Python client that drives GKE's own** `PodSnapshot`/
  `PodSnapshotManualTrigger` CRDs. Confirms the earlier finding: on our
  kind/gVisor cluster we get suspend/resume (pod-delete + PVC-retain), and
  checkpoint hibernation is a GKE-platform feature agent-sandbox merely
  wraps, not something we inherit.

Net: the adopt-the-generic-layer thesis rests on shipped code, not roadmap.
The one thing we might have wanted that *isn't* real here (portable
snapshots) is exactly the one we already flagged as unavailable.

### Redundancy map (this plan → agent-sandbox)

| This plan | agent-sandbox equivalent | Verdict |
|---|---|---|
| `Session` CRD, single pod, spec→status, phase/conditions | `Sandbox` CRD | near-identical shape — **adopt as child** |
| ownerReferences / cascading GC / finalizers (replace `reconcileVclusters` GC, orphan-Job & stuck-terminating sweeps) | built into the controller for its own children | reuse for the pod; still hand-write for yaac children |
| workqueues / leader election / `/metrics` | controller-runtime, wired | **free** |
| `Project` CR prewarm pool | `SandboxWarmPool` + `SandboxClaim` | partial — see rebrand caveat |
| Reaping / TTL (`reconcileStaleWorktrees`) | `lifecycle.shutdownTime`/`shutdownPolicy` | **yes** for time-based; death-cause reaping stays yaac |
| gVisor isolation | roadmap first-class | already have it |
| "governed while no server runs" | resident controller + suspend/resume | **yes**, modulo state model (below) |
| Job-per-session (`buildSessionJobManifest`) | Sandbox → bare **Pod** | **migration point** |
| vcluster / registry / CEC+CNP projections / salvage | — | **no equivalent — stays yaac** |

### Recommended shape: `Sandbox` as a child primitive

Keep a yaac **`Session`** CRD as the user-facing reconcile root (it carries
the domain spec — project, tool, `virtualCluster`, branch, egress config —
and gives the `kubectl get sessions` debugging surface this plan wants). The
yaac controller reconciles a `Session` into:

1. a child **`Sandbox`** for the pod, built by porting
   `drivers/k8s/substrate/pod-spec.ts buildSessionJobManifest` into a `podTemplate`
   (the per-session mounts/env are too dynamic for a static
   `SandboxTemplate`, so construct the Sandbox inline rather than via
   template); and
2. the yaac-owned children with **no agent-sandbox analogue** — the
   per-session vcluster namespace (`features/cluster/vcluster.ts`), the
   per-project registry (`features/cluster/project-registry.ts`), the
   inner-redirect/attribution CEC+CNP projections
   (the reconcile steps behind `#features/worktrees`), and image salvage
   (`features/images/image-promoter.ts`).

This deletes most of Phases 1–2's generic machinery (pod lifecycle, TTL,
GC-by-ownerReference, warm-pool bookkeeping) and leaves us writing only the
convergence agent-sandbox does not model. It costs a second resident
controller (the `agent-sandbox-system` Deployment) alongside ours.

### Mismatches to resolve before adopting

- **Job → Pod / terminal-Dead.** Today the Job's `backoffLimit:0` +
  `restartPolicy:Never` make an exited session terminal. Under a `Sandbox`
  the equivalent is: the controller won't recreate a `Failed`/`Succeeded`
  pod *as long as the pod object survives* — but if that terminal pod is
  ever GC'd it **would** be resurrected. Mitigation: on detected death the
  yaac controller flips the child `Sandbox` to `operatingMode: Suspended`,
  making death sticky. yaac's death taxonomy
  (`features/worktrees/death-reason.ts`: `oom`/`evicted`/`crashed`/
  `agent-exited`/`never-started`/`orphaned`) is far richer than the
  `Finished` condition's `PodSucceeded`/`PodFailed`, so `deriveDeathCause`
  and its pod-terminal-state reads stay ours and stamp `Session.status`.
- **Egress must stay yaac-owned.** agent-sandbox's `networkPolicy` is a
  vanilla `NetworkPolicy`, which is also the dialect our own policies use
  (docs/worktree-egress.md) — so the risk is not a schema mismatch but a
  second author writing the same objects. Set
  `networkPolicyManagement: Unmanaged` (or bypass `SandboxTemplate`
  entirely) so the controller never overwrites the session egress floor,
  which is the whole fail-closed story. Likewise our
  pods are reached via the exec tunnel + host port-forwarders, not a
  Service, so set `spec.service: false`.
- **Prewarm rebrand is the weakest fit — keep it yaac-side.** `SandboxClaim`
  binding is *adoption-based*: it can inject `env`/pod metadata at claim but
  has **no arbitrary mutation hook**. Our claim
  (`features/images/prewarm.ts tryClaimPrewarmed` → `rebranchSpare`/
  `retoolSpare` in `create.ts`) mutates the **host git worktree**
  (`git reset --hard` + upstream rewrite under a per-project lock) and execs
  tmux respawns — neither expressible as a Sandbox-spec change. Options:
  (a) keep yaac's claim path unchanged and don't model the pool as a
  `SandboxWarmPool` at all; or (b) adopt `SandboxWarmPool` only for
  pod-warming and pass branch/tool via claim-time `env` to an **in-pod
  supervisor that self-rebrands** — which folds directly into this plan's
  open question #1 (in-pod supervisor vs exec-from-controller). Recommend
  (a) first; revisit (b) if the supervisor lands for the phase-3 relay.
- **Suspend/resume needs a state model we don't have yet.** agent-sandbox
  suspend retains **PVCs**; yaac session state lives on a node hostPath
  worktree + session dir, and the live tmux/agent state is **in-pod memory**
  that today's create flow rebuilds from scratch. So "governed while no
  server runs" via suspend/resume is aspirational until the in-pod state is
  reconstructable on resume (again: in-pod supervisor territory). The
  cheaper near-term win agent-sandbox gives for free is **TTL reaping**
  (`lifecycle.shutdownTime`) surviving server downtime.

### Cost/logistics deltas vs. the "Costs" section above

- Two controllers, two CRD bundles: agent-sandbox `sandbox.yaml` +
  `extensions.yaml` (namespace `agent-sandbox-system`) plus yaac's
  `Session`. `yaac cluster setup`/`--repair` applies all three.
- The agent-sandbox controller image joins the digest-pinned upstream
  mirror set in `test/global-setup.ts` (same pattern as the vcluster image
  set and `registry:2`).
- e2e per-run-namespace isolation (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`)
  forces the same decision the controller supports via `--namespace`-scoped
  vs cluster-wide caches — this is already open question "CR namespace
  layout"; adopting agent-sandbox just means the *two* controllers must
  agree on it.
- Interaction fits the existing split: yaac writes `Sandbox`/`Session` YAML
  with kubectl and watches it with a client-node informer, matching the
  convention that writes and exec go through kubectl while reads and watches
  go through the library — the generated Go/Python clients are for the
  controller itself, not the Node server.

### Bottom line

Adopt `Sandbox` as the pod/service/PVC/TTL/suspend primitive under a yaac
`Session` controller; keep hand-written convergence only for vcluster,
registry, egress policy, salvage, and the Job→Pod + sticky-death
reconciliation. This shrinks Phases 1–3 materially. The open risks are the
prewarm-rebrand impedance and the missing suspend/resume state model — both
converge on the same unresolved decision as open question #1 (in-pod
supervisor), so **settle the supervisor question before committing to the
warm-pool and suspend/resume parts of the adoption.**
