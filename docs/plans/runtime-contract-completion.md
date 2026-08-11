# Completing the runtime contract

`runtime/contract.ts` used to promise a seam it did not deliver. Stages 1–3
have delivered the observation, pass-view and scheduling halves of it (see
"What has landed"); what remains is everything that MUTATES the substrate.
`create.ts` still builds a Job manifest, applies it, and execs into the pod
five times; `cleanup.ts` still deletes Jobs (once awaited, once as a raw
`kubectl` string in a detached shell); `prewarm.ts` still commits a spare
claim by flipping a pod label; `spare-pool.ts` still execs directly; and
`PodMount` fragments are still built in `domain/skills` and
`domain/worktrees/spawn-script`.

This plan finishes the carve-out: domain and api speak only
substrate-neutral runtime vocabulary, and every k8s verb, label, and type
lives under `runtime/k8s`. It assumes the `platform/k8s` →
`runtime/k8s/substrate` move (the file move, the `platform/container`
inversion, the CLI/exports repointing) happens first or in parallel;
nothing here depends on it beyond import specifiers, and this doc writes
`#platform/k8s` for whatever that barrel is currently called.

Two payoffs justify the work even if a second driver never ships:

- **Domain unit tests stop paying for the cluster.** Importing
  `@kubernetes/client-node` costs ~2.8s per test file; every domain test
  pays it today because domain imports `#platform/k8s`. Once domain
  reaches the substrate only through a registered driver, its tests run
  against a fake and never load the client or its stub.
- **Policy and mechanics separate cleanly.** Domain keeps the decisions
  (when to reap, what to prewarm, which hosts to allow, which windows to
  open); the driver keeps the substrate facts (how a Job is named, what a
  label means, how an exec travels). Today those interleave line-by-line
  in `create.ts`.

## The endgame

Three rules, enforced by eslint zones once the stages land:

1. `#runtime/k8s/**` is importable only from `runtime/**` and `main/**`
   (main is the composition root and may know which driver it composes).
2. Domain and api reach the substrate only through `#runtime/contract`
   (types) and `#runtime/driver` (the accessor). Their imports of
   `#runtime/status` and `#runtime/agents` are unaffected — those are
   runtime vocabulary, not k8s vocabulary.
3. No type exported from `#runtime/k8s/**` appears in a domain or api
   signature. `PodInfo`, `PodMount`, `TickSnapshot` and `DeltaSource`
   disappear above the runtime boundary.

### The driver interface, fully grown

Accumulated across the stages, `contract.ts` ends with (signatures settled
per stage; this is the shape):

```ts
interface WorktreeRuntime {
  // Observation (stage 1)
  observe(projectFilter?: string): Promise<RuntimeReport>
  find(idOrName: string, opts?: { preferCache?: boolean }):
    Promise<RuntimeHandle | undefined>
  findForTeardown(idOrName: string): Promise<TeardownTarget | undefined>
  list(projectSlug?: string): Promise<RuntimeHandle[]>
  count(): Promise<Record<string, number>>
  countForProject(slug: string): Promise<number>
  changes(jobName: string, base?: string, defaultBase?: string):
    Promise<WorktreeChanges>

  // The pass view (stage 2)
  snapshot(resync?: boolean): RuntimeSnapshot

  // Driver-contributed reconcile steps (stage 3)
  reconcileSteps(): { prePool: ReconcileStep[]; maintenance: ReconcileStep[] }

  // Transport and mutation (stage 4)
  exec(jobName: string, cmd: string,
       opts?: { timeout?: number; maxAttempts?: number }):
    Promise<{ stdout: string; stderr: string }>
  awaitAgentTransport(jobName: string, opts?: { timeoutMs?: number }):
    Promise<void>
  claimSpare(workspaceId: string, tool: AgentTool): Promise<void>
  destroy(target: TeardownTarget,
          opts?: { salvageImages?: boolean }): Promise<void>
  detachedTeardownCommand(target: TeardownTarget): string
  destroyProjectSubstrate(slug: string): Promise<void>
  pendingSpawns(): Promise<PendingSpawn[]>
  resolveSpawn(id: string, result: SpawnResult): Promise<void>

  // Launch (stage 5)
  launch(spec: WorkspaceSpec): Promise<RuntimeHandle>
  awaitReady(handle: RuntimeHandle): Promise<void>
  registerWorkspace(reg: WorkspaceRegistration): Promise<void>
}
```

`RuntimeHandle.jobName` stays "the runtime's own name for it, which is what
an exec addresses" — a host-process driver would put a process-group id
there. `TeardownTarget` is `{ projectSlug, workspaceId }` only: the unit
name is derived deterministically by the driver (today `worktreeJobName`),
so domain never needs to compute a Job name before or after a launch.

### The accessor

`packages/server/src/runtime/driver.ts` (`#runtime/driver`, resolved by the
existing `#*` catch-all in the imports map — no map change needed) holds the
registered driver behind `setWorktreeRuntime()` / `worktreeRuntime()`, the
same module-singleton pattern as `setActiveClusterCache`. It imports only
`./contract`, so a domain file that imports it pulls no k8s code.
`main/server-run` registers the k8s driver at boot; unit tests register a
fake. This, not the interface, is what buys the test-time win: with direct
`#runtime/k8s/worktrees` imports, domain tests would still transitively
load the k8s client.

The k8s driver object itself lives at
`packages/server/src/runtime/k8s/runtime.ts` — above the sealed folders,
assembling the interface from their barrels (`worktrees` for observation,
`substrate` for exec/waits, `cluster`/`egress`/`images` for teardown,
registration, and the contributed steps). It is deliberately thin: every
method is a one-line delegation, so it needs no unit tests of its own — the
functions it wraps keep theirs, and e2e covers the wiring.

### Enforcement is a ratchet, not a flip

Stage 1 adds the endgame eslint pattern to the domain and api zones —
restricting `#platform/k8s` and `#runtime/k8s` — together with a holdout
override: a later flat-config object whose `files` list names the
not-yet-migrated domain files and re-declares the rule without that
pattern. Each stage deletes its files from the holdout list; stage 6
deletes the override. That makes "what's left" a fact in the lint config
rather than a grep someone has to remember, and a new domain file is born
restricted.

### The test fake

`packages/test-utils` gains `fake-runtime.ts`: a `WorktreeRuntime` built
from overridable defaults (empty lists, resolved voids, a fake
`RuntimeSnapshot`), installed via `setWorktreeRuntime` and torn down by an
`afterEach` the module arms on import — so a file that installs one cannot
leak it by forgetting a hook. Domain tests that today `vi.mock` platform
modules or lean on the k8s stub switch to
`installFakeWorktreeRuntime({ list: async () => [handleFixture(...)] })`.
`test/domain/worktrees/resolve.test.ts` and `restart.test.ts` already build
`RuntimeHandle` fixtures — those fixtures become the shared
`handleFixture()` helper.

---

## What has landed

Stages 1–3 are in. The contract, the accessor, the boundary mapper and the
pass view are real; the mediators' observation, snapshot and scheduling
paths all go through them. Lint, `pnpm modularity --runtime-only` and the
`unit:server` suite are green.

**The pieces, and where they live.** `runtime/contract.ts` holds the
`WorktreeRuntime` interface and its vocabulary; `runtime/driver.ts`
(`#runtime/driver`) holds the registered instance behind
`setWorktreeRuntime` / `worktreeRuntime`. Both import only shared types, so
they are a sink in the module graph and a mediator that reaches the runtime
through them pulls no cluster code in.

Two placements differ from what this plan first proposed, both forced by
the module graph:

- **The driver assembly is `main/runtime-k8s.ts`, not
  `runtime/k8s/runtime.ts`.** Assembling it means importing every sealed
  k8s folder, and those folders import `#runtime/contract` — so putting the
  assembly in the same module bucket as the contract closes a cycle
  (`pnpm modularity` catches it). `main` is the composition root, imports
  nothing back, and is where the choice of runtime belongs anyway. Its
  contributed step list is `main/runtime-k8s-steps.ts` beside it.
- **`runtime/k8s/view` is a new sealed folder** holding
  `runtimeHandleFromPod` (the one place a pod becomes a `RuntimeHandle`,
  death-cause derivation included) and the pass snapshot. It is separate
  from `worktrees` because `cluster` and `egress` need the pass view too,
  and `worktrees` imports `egress` — folding it in cycles for the same
  reason.

**Contract shapes that differ from the sketch above:**

- `TeardownTarget` carries `unitName` as well as the identity. The stop
  route reports the unit name on the wire, and a teardown must be able to
  address a unit whose workspace is already gone — which is exactly when
  there is nothing left to derive one from. The runtime still produces it;
  no mediator constructs one.
- `RuntimeHandle` carries `declaredTool` beside `tool`. `tool` always
  resolves to something runnable, but the spawn drain needs to know whether
  the caller *declared* a tool this build knows — a resolved guess there
  would outrank the server's configured default. Normalizing at the
  boundary without this silently changed that behavior, which the spawn
  tests caught.
- `RuntimeHandle` also carries `mode`, `terminating` and `deathCause`, so
  `classifyWorktreePods` and the reaper read contract vocabulary rather
  than `PodInfo`.
- `RuntimeSnapshot` is `{ resync, workspaces(), strayUnits() }`.
  `strayUnits` computes "unit with no workspace" from ONE memoized instant
  inside the driver, which is stronger than the cross-referencing the
  reaper used to do itself.
- `ReconcileTrigger`, `ReconcileStep` and `PassContext` moved to the
  contract; `PassContext` gained `projectSlugs()`. The mediators' triggers
  are `workspaces` / `units` / `poll` / `live-agents`, with the driver's
  own sources (the vcluster informers) riding an open tail that only its
  own steps name. `main/convergence` translates at the fan-out.

**Testing.** `@yaac/test-utils/fake-runtime` gives `installFakeWorktreeRuntime`,
`handleFixture`, `snapshotFixture` and `passViewFixture`;
`@yaac/test-utils/real-runtime` gives `installRealWorktreeRuntime` for tests
that mean to exercise a mediator and the driver together with only the
process boundary mocked. Importing `fake-runtime` arms an `afterEach` that
forgets whatever was installed, so no test file has to remember one. They are separate modules on purpose — importing
the real one pulls the k8s client, which is the cost the fake exists to
avoid. The api project registers the real runtime from `cluster-setup.ts`,
because it builds the Hono app in-process and never goes through the
composition root the way e2e does.

**The ratchet is live, for domain.** `NO_SUBSTRATE_ABOVE_RUNTIME` is on the
domain zone, with a holdout override in `eslint.config.js` naming the files
that have not moved. What is left there is exactly that list — stage 4's
five files, stage 5's three, and `domain/worktrees/detail.ts`, which needs
`readBlockedHosts` and `getVclusterStatus` as contract verbs.

The **api zone is not on the rule yet**, and its substrate use is a
different shape from domain's: the image-build rows the webapp renders
(`api/events`, `api/routes/images`), the proxy client behind the auth and
allow-host routes, the port-forward routes, and the project rebuild/push
routes. None of that is worktree lifecycle, so none of it is covered by
stages 4–5; it wants its own pass over what belongs on the contract (an
image-build feed, a datapath surface) rather than being forced through the
worktree verbs. Stage 6 should not flip api until that is decided.

**Also moved:** `worktreeForkFallback` left `runtime/k8s/worktrees/changes`
for `domain/worktrees/fork-branch.ts`. It reads the checkout's own git
config host-side and never touched the substrate; its tests now mock
`#platform/git`, the real process boundary.

---

## Stage 4 — exec, claim, destroy, and the egress verbs

Adds the mutation verbs and migrates every mutating domain file except
`create.ts`. This is the second-largest stage because `cleanup.ts` touches
four driver subsystems.

**Contract additions**: `exec`, `awaitAgentTransport`, `claimSpare`,
`destroy`, `detachedTeardownCommand`, `destroyProjectSubstrate`,
`pendingSpawns`, `resolveSpawn`. The pending-spawn wire types
(`PendingSpawn`, `SpawnResultWire`) move to `@yaac/shared/types` — they
cross the proxy wire already and belong with the other wire types.

The planner half of `prewarm.ts` is already on `RuntimeHandle`; what is
left in that file is the claim, which is where the substrate calls are.

**Consumers migrated**:

- `prewarm.ts` (claim path): `waitForStreamd` → `awaitAgentTransport`
  (re-booting a dead streamd stays driver semantics; a failed gate still
  degrades to a cold create with the spare untouched). The label-flip
  commit becomes `claimSpare(workspaceId, tool)` — the driver flips
  `LABEL_PREWARMED`/`LABEL_TOOL` by label selector on the worktree id
  rather than by pod name, so the handle needs no pod identity. Note the
  claim also has to clear `declaredTool`'s source of truth consistently:
  a retooled spare must report the tool it was claimed for. The
  post-commit git-identity exec goes through `exec` and stays non-fatal.
- `spare-pool.ts`: five `podExec` calls → `exec`, timeouts preserved
  (including rebranch's widened 120s reset). Command strings keep coming
  from `#runtime/agents` and the pure `buildRebranchPrep`; only transport
  changes. Its `proxyClient`/`buildWorktreeRegistration` use becomes
  `registerWorkspace` (defined this stage, shared with create in stage 5).
- `cleanup.ts`: the awaited path becomes `destroy(target,
  { salvageImages })`. `TeardownTarget` already carries the unit name (it
  landed that way in stage 1), so nothing has to be re-derived at teardown
  — the driver composes what cleanup sequences today:
  image salvage, forwarder stop, proxy deregistration, the foreground
  Job delete with its 30s wait, and vcluster removal. The detached path
  composes `detachedTeardownCommand(target)` into its shell script exactly
  as it already composes `buildVclusterCleanupShellCommand`; the vcluster
  fragment folds into that command. Domain keeps: terminating marks and
  status eviction (`#runtime/status`), the records event, provisioning
  registry bookkeeping, and directory removal. This deletes cleanup's
  imports from `#runtime/k8s/{cluster,egress,images,forwarders}` and
  `#platform/k8s` in one motion — review it as a re-sequencing risk, and
  lean on the e2e stop/teardown assertions, which must not change.
- `spawn-reconcile.ts`: `proxyClient` drain/answer → `pendingSpawns` /
  `resolveSpawn`. `decideSpawn` (tool precedence, fan-out cap, minted id)
  stays domain.
- `project-purge.ts`: `removeProjectRegistry` → `destroyProjectSubstrate`.
- `stop.ts`: already observation-clean from stage 1; its teardown
  delegation to cleanup is unchanged.

**A live race this stage should fix, not just carry.** A restart tears down
through `teardownForRestart` and then creates against the same id, and
between those two the workspace is terminating, no longer marked, and not
yet in the provisioning registry. A restart slow enough to spend minutes in
that window — a cold one, pushing an image and creating a vcluster — gets
its stuck-terminating sweep fired by the reaper, which runs the full
teardown and prunes the checkout out from under the retrying create; the
pod then wedges in `ContainerCreating` on a `hostPath type check failed`
for a staged dir that is gone. Observed on a live cluster (PR #89), and
pre-existing: the reaper's guards are untouched by the carve-out, and
`cleanup.ts` is where the window lives. The fix belongs here because this
stage is what gives teardown a verb — a restart's teardown should hold the
id against the reaper for the whole gap, rather than relying on the
provisioning registry to be populated before the sweep looks.

**Error taxonomy**: no domain caller today branches on `RelayExecError`
(that logic lives in `runtime/agents`), so `exec` surfaces plain errors
and the contract defers an error taxonomy until a caller needs one.

## Stage 5 — launch

The largest stage; `create.ts` (~1500 lines) is the whole scope, and the
cut line is policy above, substrate below. Domain keeps: checkout staging
and its failure promise, config resolution, image *decisions*, allowed-host
resolution, init-window content, records writes. The driver absorbs how
any of it becomes cluster objects.

**Contract additions**: `WorkspaceSpec`, `WorkspaceMount` (renamed
`PodMount` — hostPath source, mount path, readOnly; a host-process driver
reads it as a bind or symlink), `launch(spec)`, `awaitReady(handle)`,
`WorkspaceRegistration` + `registerWorkspace` (from stage 4).

The spec carries decisions, not k8s spellings: identity (project,
workspaceId, tool, mode, prewarm), image ref, env, mounts, resources,
post-start script name, allowed hosts, forwarded-port config, and the
nested/vcluster wants. Labels, namespace, `dataDirHash`, priority classes
and the manifest are how the k8s driver spells it.

Destination of each of `create.ts`'s substrate touches:

| today | destination |
|---|---|
| `worktreeJobName` (named before staging) | gone — `TeardownTarget` and post-launch `handle.jobName` cover every use |
| `buildPodJobManifest` + label constants + `worktreeIdLabels` + `dataDirHash` + `k8sNamespace` | inside `launch` |
| `ensurePriorityClasses` → `kubectlApply` | inside `launch`, same order |
| retry loop's foreground-cascade delete | inside `launch` — the "never match the previous attempt's terminating pod" invariant is the driver's own |
| `awaitDeferredClusterBoot` | inside `launch`; domain stops knowing boots defer |
| `waitForJobPodReady` / `waitForStreamd` | `awaitReady` / `awaitAgentTransport`; the race against the checkout-failure promise stays in domain, where the checkout lives |
| `podStreamToken` → `YAAC_STREAM_TOKEN` | driver injects during `launch` |
| `SSH_TUNNEL_SENTINEL`, `TUNNEL_INGRESS_PORT`, `SSH_AGENT_*` env/ProxyCommand assembly | a "git/ssh env for this workspace" builder in `runtime/k8s/egress`, surfaced through the spec |
| five post-ready `podExec` calls | `exec`, strings unchanged from `#runtime/agents` |
| `relayTcpFactory` → `registerWorktreeForwarders` | forwarders build their own factory from the worktree id; the registration rides the spec's port config |
| vcluster family (`ensureWorktreeVcluster`, kubeconfig wait, `sleepVcluster`, activator, registry conf drop-in, mounts) | driver-internal, keyed off the spec's nested/vcluster fields |
| `ensureImage` / `primeWorktreeImages` / `pushImageShared` | stay explicit pre-launch calls, but behind contract verbs (`prepareImage(...)` family) rather than `#runtime/k8s/images` imports — which image to build from what config is domain's; building is the driver's |
| `buildWorktreeRegistration` / `syncProxySecrets` / `proxyClient` | `registerWorkspace`, called by `launch` |

`domain/skills/builtin.ts` and `domain/worktrees/spawn-script.ts` change
only their import: `PodMount` → contract `WorkspaceMount`, logic
untouched.

The extracted launch lands in `runtime/k8s/worktrees` (a `launch.ts`
module; the barrel grows `launchWorkspace` with its one-`describe` test
whose k8s boundary is mocked at kubectl/spawn per the folder rules).
`create.ts` ends importing `#runtime/driver`, `#runtime/contract`,
`#runtime/agents`, `#runtime/status` — and nothing k8s.

## Stage 6 — enforcement flip and doc truth

- Delete the holdout override; the domain/api zones now restrict
  `#platform/k8s` and `#runtime/k8s` outright. Add the mirror rule:
  `#runtime/k8s/**` importable only from `packages/server/src/runtime/**`
  and `packages/server/src/main/**`.
- Update `docs/layered-server.md`: runtime's entry describes the
  `WorktreeRuntime` contract and accessor as real; domain's entry says it
  drives the runtime through the contract. Update the sealed-folder
  guidance if `runtime/k8s/runtime.ts` and `driver.ts` deserve a mention.
- Optional, separable: fold `main/convergence`'s cluster wiring
  (`ClusterCache` construction, delta fan-out, priority classes, deferred
  boot arming, relay invalidation) behind `runtime.start()` /
  `runtime.stop()`. Main composes the concrete driver, so leaving
  convergence k8s-aware breaks no rule; do this only if the wiring starts
  duplicating for a second driver.

## Deliberately out of scope

`runtime/agents`, `runtime/status`, and `runtime/terminals` keep their
direct bindings to the stream relay (`podExec`, `dialCtrlStream`,
`dialPtyStream`) — they are runtime-internal, the tui/acp drivers already
take an injectable `dial`, and rule 1 permits it. A true second driver
would need the dial transport on the contract too; that extension has an
obvious seat beside `exec` but no payoff until such a driver exists.
Likewise the api layer keeps reaching `#runtime/terminals` for PTY routes,
and sinking spare-pool's retool/rebranch sequences into `runtime/agents`
is a possible later refinement, not part of this plan.

## Verification per stage

- `pnpm lint` and `pnpm modularity --runtime-only` stay green; the holdout
  list shrinks in the same PR as each migration.
- Domain test wall-clock drops at stage 1 and again at stage 5 (the k8s
  client import stops loading); migrated files' tests must pass with no
  k8s stub registered.
- E2e is the behavioral backstop: worktree-create-suite, vcluster-suite,
  and the stop/cleanup paths exercise every moved verb against a real
  cluster, and none of their assertions should change — this refactor
  moves code across a boundary and must not change what the substrate
  sees. Stages 4 and 5 are the ones to run nested-vs-host both ways.
