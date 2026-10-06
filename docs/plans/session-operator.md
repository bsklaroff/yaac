# Session operator: declarative sessions with an in-cluster Go controller

## Context

Under the `k8s` driver the server is already an in-cluster Deployment
(docs/server-in-cluster.md). Intent persists as database rows, and the
server's reconcile loop (`main/reconciler.ts`, step list in
`domain/reconcile.ts`) converges the cluster toward it from informer caches
(docs/event-driven-reconcile.md). Provisioning itself is still an
imperative call stack (`domain/workspaces/create.ts` down to
`launchWorkspace` in `drivers/k8s/workspaces/launch.ts`), and orphaned or
half-built state is cleaned up by sweeps.

This plan would move cluster convergence into a `Session` custom resource
(the persisted source of truth) and a Go controller built on
controller-runtime. The motivation is architectural, not CPU. Triggers that
would justify it:

- **Multi-node and cloud** (docs/cluster-setup.md "Bring your own
  cluster"): scheduling and healing across disposable nodes suit a
  controller with per-object workqueues better than one reconcile pass.
- **Convergence while the server is down**: reaping, prewarm and
  image upkeep stop whenever the server pod does (`yaac server stop`
  scales it to zero; upgrades roll it; it can crash).
- **Multiple writers**: CLI, desktop, web and e2e harnesses all go through
  the one server process, which acts as an implicit lock. CRs give
  optimistic concurrency with one arbiter, and `kubectl get sessions`
  becomes a debugging surface.

Do not start this until at least one trigger is committed. The informer
layer is reusable either way: it is the shape a controller consumes.

## Domain model

`Session` (yaac.dev/v1alpha1), sketch:

```yaml
apiVersion: yaac.dev/v1alpha1
kind: Session
spec:
  project: my-app            # slug; resolves repo + storage paths
  tool: claude
  image: <registry>/yaac-proj-<id>:<hash>   # built before the CR is written
  branch: {base: main, agent: agent/<id>}
  nestedContainers: true
  prewarm: false
  initCommands: [...]
  memory: {requestBytes: ..., limitBytes: ...}
status:
  phase: Provisioning | Running | Waiting | Dead
  podName: ...
  deathCause: {reason: oom, detail: exit code 137}
  conditions:
    - {type: EgressRegistered, ...}
    - {type: AgentStarted, ...}
```

A `Project` CR probably sits beside it (prewarm pool size, image-chain
state) so the prewarm pool is declarative too. The per-project registry,
the workspace's egress-proxy registration ConfigMap, and image-salvage pods
become owned children of the Session instead of objects that separate
sweeps collect.

## Controller responsibilities

Converge spec to status per Session: ensure the registry and the egress
registration, create the Job, run the tmux/agent bootstrap, watch the pod,
and record status and death cause. Standard machinery replaces hand-written
code:

- **ownerReferences and cascading GC** replace the orphan-Job and
  stuck-terminating sweeps in `reconcileStaleWorkspaces` and their grace
  windows.
- **Finalizers** replace ordered teardown (image salvage before the Job
  goes).
- **Per-object rate-limited workqueues** replace tick throttles. Leader
  election and `/metrics` come with controller-runtime.
- **Level-based reconciliation** removes the half-provisioned cleanup
  class. A crash mid-create just means the next reconcile keeps going. The
  placeholder-pane sweep in `reconcileStaleWorkspaces` exists because "tmux
  opened, agent never started" is reachable today.

## The server boundary

The server keeps what is not cluster-state convergence and becomes a
gateway for the rest:

- **Stays in the server:** HTTP/WS for clients, terminals over the stream
  relay (docs/stream-relay.md), port-forward tunnels
  (docs/port-forward-tunnel.md), git in project repos
  (docs/server-git.md), driving sandboxed builder pods for untrusted image
  layers (docs/trust-split-builds.md), the database, title generation.
- **Moves to the controller:** cluster-state convergence.
- **Create crosses the boundary:** the server builds the image and
  prepares the checkout, writes a Session naming the tag, then watches
  status. The controller consumes those outputs and never touches the
  server's storage or database.

The server is today the only author of egress objects (NetworkPolicies and
proxy registrations, docs/workspace-egress.md). That authorship moves to the
controller and must stay out of tenant reach. The spec becomes attack
surface: validate it with a ValidatingAdmissionPolicy, the pattern the
builder-role guard already uses (`buildBuilderRoleGuardPolicyManifest`).

## Costs

- A second language and build artifact. A Go controller image follows the
  `k8s/proxy` pattern: built with a content-hash tag, pushed to the local
  registry, prebuilt for e2e in `test/global-setup.ts`.
- CRD versioning discipline, and a heavier `yaac cluster install` (CRDs
  plus the controller Deployment, re-applied every install).
- e2e isolates each run in its own namespace
  (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`). Either one shared controller
  serves every test namespace, or each run gets a namespace-scoped
  controller. Decide early: it shapes RBAC and the global setup.
- Debugging moves to `kubectl describe session`, controller logs and
  status conditions. The server log no longer tells the whole story.
- Local installs carry one more resident pod. Keep it lean: no webhooks
  unless admission policy proves insufficient.

## Phases

1. **Shadow mode.** Define the CRD. The server writes a Session alongside
   today's flow, and a read-only controller records status. No behavior
   change; this validates the model against real lifecycles, including
   prewarm claim and nested containers.
2. **GC and teardown.** ownerReferences on registry, salvage pods and
   egress objects; a finalizer for ordered teardown. Delete the matching
   sweeps from the reconcile step list.
3. **Provisioning.** The controller creates the Job and runs bootstrap.
   The server's create path becomes build, write CR, watch status.
4. **Gateway.** The server stops writing cluster state. CLI, desktop and
   e2e may write CRs directly where useful.

## Open questions

- **Bootstrap:** does the controller exec into the pod (tmux setup, agent
  respawn, nested podman service), or does an in-pod supervisor do it so
  the controller only creates the Job? `streamd` and `acpd` already run in
  the pod and are candidates to grow into that supervisor.
- **Prewarm claim:** a claim rewrites the checkout's branch and upstream
  and retools the agent (`tryClaimPrewarmed` in
  `domain/workspaces/prewarm.ts`, `rebranchSpare`/`retoolSpare` in
  `spare-pool.ts`). Most likely it stays a server action that patches the
  spec, with the controller converging the retool.
- **CR scope:** one namespace per install (matching today's
  `YAAC_K8S_NAMESPACE` scoping) or cluster-scoped with install labels.
- **Status latency:** the server would inform on Session status through
  the same informer layer. Check that the snapshot hub's 150ms coalesce
  still holds end to end.

## Prior art: kubernetes-sigs/agent-sandbox

[`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox)
is a SIG-Apps project for "isolated, stateful, singleton workloads, ideal
for AI agent runtimes". Its API is at `v1beta1` (`agents.x-k8s.io`) with a
controller-runtime controller. It already covers the generic half of this
plan (pod lifecycle, GC, TTL, warm pools). It has nothing for the
yaac-specific half: per-project registries, the netd egress redirect and
proxy registrations, image salvage. So this plan's real decision is build
versus adopt for the generic layer.

### What it provides

These were checked against its source, not just its README:

- **`Sandbox`**: one stateful Pod (not a Job) with stable identity, an
  optional headless Service, and `volumeClaimTemplates`.
  `spec.lifecycle` gives TTL reaping (`shutdownTime`,
  `shutdownPolicy: Delete|Retain`). `spec.operatingMode: Suspended`
  deletes the pod but keeps PVCs and the Service; `Running` recreates the
  pod only when none exists by name. A pod that reached
  `Succeeded`/`Failed` stays in place with a `Finished` condition and is
  not resurrected.
- **`SandboxTemplate`**: a reusable pod spec plus an optional managed
  `NetworkPolicy` (`networkPolicyManagement: Managed|Unmanaged`).
- **`SandboxWarmPool` + `SandboxClaim`**: a replica reconciler for warm
  pods, and a claim that checks one out. A claim can inject `env` and pod
  metadata, gated by template policy, but cannot run arbitrary mutations.
- **Webhooks** are only for API-version conversion and manage their own
  certs (no cert-manager). They can be turned off at the cost of
  conversion. Ships as plain manifests or a Helm chart in
  `agent-sandbox-system`.
- **Snapshots** (checkpoint/restore) are not implemented there; it only
  wraps GKE's own snapshot CRDs. On a kind or self-managed gVisor cluster
  suspend/resume means pod delete plus PVC retain, not hibernation.

### Mapping

| This plan | agent-sandbox | Verdict |
|---|---|---|
| `Session` CRD, single pod, spec to status | `Sandbox` | adopt as a child |
| ownerReferences, cascading GC, finalizers | built in for its own children | reuse for the pod; write our own for yaac children |
| workqueues, leader election, `/metrics` | controller-runtime | free |
| `Project` CR prewarm pool | `SandboxWarmPool` + `SandboxClaim` | partial (claim caveat below) |
| Time-based reaping | `lifecycle.shutdownTime` | yes; death-cause reaping stays ours |
| Job per workspace (`buildPodJobManifest`) | bare Pod | migration point |
| per-project registry, egress registration, image salvage | none | stays yaac |

### Recommended shape

Keep a yaac `Session` CRD as the root: it carries the domain spec and gives
`kubectl get sessions`. The yaac controller reconciles it into:

1. a child `Sandbox` for the pod, built inline by porting
   `buildPodJobManifest` (`drivers/k8s/substrate/pod-spec.ts`) into a
   `podTemplate`. Per-workspace mounts and env are too dynamic for a static
   `SandboxTemplate`.
2. the children agent-sandbox has no model for: the per-project registry
   (`drivers/k8s/cluster/project-registry.ts`), the egress proxy
   registration (`drivers/k8s/egress/proxy-registration.ts`), and image
   salvage (`drivers/k8s/images/image-promoter.ts`,
   `drivers/k8s/workspaces/salvage-reconcile.ts`).

This removes most of phases 1–3's generic work and leaves only
yaac-specific convergence. It costs a second resident controller.

### Mismatches to resolve first

- **Job to Pod, and sticky death.** Today `restartPolicy: Never` on a
  single-pod Job makes an exited workspace final. Under `Sandbox` a
  finished pod is left alone only while the pod object exists; if it is
  garbage-collected, the controller recreates it. Fix: on death, the yaac
  controller sets the child to `operatingMode: Suspended`. yaac's death
  reasons (`WorkspaceDeathReason` in `@yaac/shared/types`: `oom`,
  `evicted`, `crashed`, `pod-stopped`, `agent-exited`, `never-started`,
  `orphaned`) are much richer than `Finished`, so `deriveDeathCause`
  (`drivers/k8s/workspaces/handle.ts`) stays ours and writes
  `Session.status`.
- **Egress stays yaac-owned.** agent-sandbox writes plain NetworkPolicy,
  the same kind ours are (docs/workspace-egress.md). The risk is two
  authors of the same objects, which would break the default-deny
  guarantee. Use `networkPolicyManagement: Unmanaged` or skip
  `SandboxTemplate`. Pods are reached through the proxy's stream relay,
  not a per-pod Service, so set `spec.service: false`.
- **Prewarm claim fits poorly; keep it yaac-side.** Our claim rewrites the
  checkout's branch under a per-project lock and respawns tmux panes.
  Neither is a Sandbox spec change. Option (a): keep yaac's claim path and
  don't use `SandboxWarmPool`. Option (b): use it only to warm pods, and
  pass branch and tool through claim-time `env` to an in-pod supervisor
  that rebrands itself. Start with (a); revisit (b) if the supervisor from
  the first open question lands.
- **Suspend/resume needs a state model.** Suspend keeps PVCs. A yaac
  workspace's checkout and transcripts live on the shared `yaac-global`
  claim, but the live tmux and agent state is in pod memory and create
  rebuilds it from scratch. Resume is not useful until that state can be
  reconstructed in-pod. The cheap win is TTL reaping that keeps working
  while the server is down.

### Cost deltas

- Two controllers and three CRD bundles: agent-sandbox's two plus yaac's
  `Session`. `yaac cluster install` applies all of them.
- The agent-sandbox controller image joins the digest-pinned upstream
  mirror set in `test/global-setup.ts`, like `registry:2`.
- Both controllers must agree on the CR-scope open question for e2e
  namespace isolation.
- The server writes `Session` objects with kubectl and watches them
  through the client-node informer layer, matching today's split
  (docs/event-driven-reconcile.md "Why writes and exec stay on
  kubectl").

### Bottom line

Adopt `Sandbox` for pod, TTL and suspend under a yaac `Session`
controller. Write our own convergence only for the registry, egress,
salvage, and sticky death. The open risks are the prewarm claim and the
missing suspend/resume state model. Both depend on the in-pod supervisor
question, so settle that before adopting the warm-pool or suspend parts.
