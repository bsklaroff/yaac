# Completing the runtime contract

`runtime/contract.ts` used to promise a seam it did not deliver. Stages 1–5
have delivered it for the WORKTREE lifecycle: observation, the pass view,
scheduling, every mutation, and the launch. What remains is the layer
consolidation the contract makes possible — stages 6–8: dissolve
`platform` (6), dissolve `store` between domain and runtime (7), and flip
the api zone to domain-and-records-only (8).

This plan's goal was that domain and api speak only substrate-neutral
runtime vocabulary, with every k8s verb, label, and type under
`runtime/k8s`. Domain is there. The endgame of stages 6–8 is one mediating
layer: everything below domain is either rows (`records`) or a
contract-fronted driver (`runtime`), over the dependency-free `src/lib`,
with no sanctioned sideways edges left in the layer diagram and `platform`
and `store` gone as layer names.
This doc writes `#platform/k8s` for that barrel until stage 6 renames it.

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
2. Domain reaches the substrate only through `#runtime/contract` (types)
   and `#runtime/driver` (the accessor). Its imports of `#runtime/status`
   and `#runtime/agents` are unaffected — those are runtime vocabulary,
   not k8s vocabulary. Api is held to a stricter rule than this one:
   stage 8 bans every value import below domain and records, driver
   included; only type imports of `#runtime/contract` remain legal there.
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

  // Transport, claim, teardown, egress (stage 4 — see "What has landed"
  // for the signatures as they actually shipped)
  exec(...); awaitAgentTransport(...); claimSpare(...)
  registerWorkspace(...); deregisterWorkspace(...); salvageImages(...)
  destroy(...); detachedTeardownCommand(...); destroyProjectSubstrate(...)
  pendingSpawns(); resolveSpawns(...)
  blockedHosts(...); virtualClusterStatus(...)

  // Launch (stage 5 — see "Stage 5 is in" for what shipped)
  ensureBuildEngine(); prepareImage(...); prepareSubstrate(...)
  launch(spec: WorkspaceSpec): Promise<RuntimeHandle>
  awaitReady(handle: RuntimeHandle): Promise<void>
  startForwarders(...)
}
```

`RuntimeHandle.jobName` stays "the runtime's own name for it, which is what
an exec addresses" — a host-process driver would put a process-group id
there.

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

The k8s driver object assembles the interface from the sealed folders'
barrels (`worktrees` for observation, claim and teardown, `#platform/k8s`
for exec/waits, `cluster`/`egress`/`images` for the rest). It is
deliberately thin: every method is a one-line delegation, so it needs no
unit tests of its own — the functions it wraps keep theirs, and e2e covers
the wiring. It lives in `main/`, not `runtime/k8s/` (see "What has
landed").

### Enforcement is a ratchet, not a flip

Stage 1 added the endgame eslint pattern to the domain zone — restricting
`#platform/k8s` and `#runtime/k8s` — together with a holdout override: a
later flat-config object whose `files` list named the not-yet-migrated
domain files and re-declared the rule without that pattern. Each stage
deleted its files from the list; stage 5 emptied it and deleted the
override, so the domain rule is enforced outright and a new domain file is
born restricted. What is left for stage 8 is the api zone.

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

Stages 1–4 are in. The contract, the accessor, the boundary mapper, the
pass view and every mutation verb but the launch are real; the mediators'
observation, snapshot, scheduling, teardown, claim and spawn-drain paths all
go through them. Lint, `pnpm modularity --runtime-only` and the `unit:server`
suite are green.

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
that have not moved. What is left there is exactly stage 5's three files.

### Stage 4 is in too: the mutation verbs

`exec`, `awaitAgentTransport`, `claimSpare`, `registerWorkspace`,
`deregisterWorkspace`, `salvageImages`, `destroy`,
`detachedTeardownCommand`, `destroyProjectSubstrate`, `pendingSpawns`,
`resolveSpawns`, `blockedHosts` and `virtualClusterStatus` are on the
contract, and `cleanup.ts`, `prewarm.ts`, `spare-pool.ts`,
`spawn-reconcile.ts`, `project-purge.ts` and `detail.ts` left the holdout
list. Where the shapes differ from the sketch above, the reason:

- **`destroy` returns a boolean**, not void. The prewarm reap and the
  failed-claim rollback gate checkout removal on "did the runtime really
  go away" — what is still shutting down is still writing to /workspace.
- **`deregisterWorkspace` and `salvageImages` sit beside it**, because the
  DETACHED teardown needs the in-process half of a destroy (forwarders,
  the egress registration; then the salvage, which reaches into the
  workspace) without the awaited delete. `destroy` composes the same two
  internally, so the ordering has one home either way.
- **`resolveSpawns` takes the batch**, matching the single POST the proxy's
  answer endpoint accepts.
- **`blockedHosts` and `virtualClusterStatus` are on `WorktreeRuntime`**,
  not a second display seam. The contract already carries `blockedHosts`
  per workspace in its report and `changes()` is already a pure display
  read, so a second accessor and a second fake would have bought nothing
  for two verbs. If the api layer's own surface (an image-build feed, a
  datapath surface) ever accumulates, that is the moment to split.

**Types that moved with them.** `PendingSpawn`, `SpawnResultWire` and
`pendingSpawnWorktreeId` are in `@yaac/shared/types` — they mirror the
proxy's wire shapes, and the runtime that drains the queue and the mediator
that answers each request both name them. `VclusterStatus` is
`VirtualClusterStatus` in the contract: the config key is `virtualCluster`
and the shape says nothing about how a driver realizes one, so
`WorktreeDetail` no longer names a `#runtime/k8s` type (rule 3). Both are
type-level moves; no wire changed.

**Where the driver half lives.** `runtime/k8s/worktrees/teardown.ts`
(destroy, deregister, salvage, the detached command, the project sweep) and
`runtime/k8s/worktrees/claim.ts`, both inside the already-sealed folder —
no new barrel, no `imports` entry. Teardown adds one folder edge,
`worktrees → cluster`; it is safe because nothing inside `runtime/k8s`
imports `worktrees` (only `main` does), so an outbound edge from it cannot
close a cycle. `pnpm modularity --runtime-only` confirms it: the metrics are
byte-identical to before the change. `registerWorkspace` and
`drainPendingSpawns` are new barrel exports of `egress`, adding no edges.

**The verb boundary at teardown.** The mediator keeps what is bookkeeping
about the WORKSPACE — the terminating mark (before the status eviction, so
the display renders "terminating…" rather than a stray waiting spell), the
`worktree-stopped` record with its `preserveDeletedRecord` case, the
evictions, and which directories a worktree owns. The driver owns the
sequence over cluster objects, and the order is the substance: deregister
(nothing routes at a dying workspace), salvage (it execs into the pod the
delete destroys), foreground-cascade delete with its 30s wait (background
propagation would return with the pod still writing), then the probe-gated
vcluster removal. The mediator removes its dirs only after `destroy`
resolves. `detachedTeardownCommand` returns the substrate fragment only —
every line idempotent, since resuming a teardown re-issues the whole script
— and the mediator appends its own removals and owns the spawn.

**`claimSpare` is addressed by selector**, with `prewarmed=true` as a
precondition rather than by pod name: a `RuntimeHandle` names no pod, and
the precondition is what makes the commit at-most-once. `kubectl label -l`
exits 0 on an empty match, so an empty match is checked and thrown —
that throw is what keeps a lost race degrading to a cold create. The tool
label is always stamped, which makes the guarantee unconditional: after the
claim, every observed handle reports `declaredTool === tool`, which is what
a `yaac-spawn` from the claimed workspace reads.

**The restart/reaper race is closed.** `restartWorktree` now registers its
own provisioning hold, from before `teardownForRestart` until the create
returns. The gap it covers is real and was CLI-specific: the webapp route
registers a row from what it knows, the CLI sends no `projectSlug` and so
had no hold at all, and between the teardown and the create the workspace
is terminating, unmarked and backed by nothing — long enough on a cold
restart for the stuck-terminating sweep to prune the staged dirs out from
under the create (PR #89). `registerProvisioning` is an idempotent
overwrite, so the route's earlier row is refreshed with the resolved
project and tool, and `runProvisioned` still owns dropping it. Safety is now
a property of restarting rather than of which caller registered first.

**Testing.** The driver half is tested where it lives —
`test/runtime/k8s/worktrees/{teardown,claim}.test.ts` and the egress
files — mocked at kubectl, the proxy client and the forwarder registry, and
carrying the kubectl-argv assertions that used to sit in `cleanup.test.ts`.
The migrated domain tests dropped their `#platform/k8s` mocks for
`installFakeWorktreeRuntime` and keep asserting the domain sequencing:
mark-before-evict, the verdict gates, the composed script, and that the
detached spawn waits for the salvage. `prewarm.test.ts` runs in ~50ms now
that it loads no cluster client.

One residue, deliberately left for stage 5: `spare-pool.ts` still imports
`withUpstreamConfigLock` from `./create`, so its module graph is only
cluster-free once `create.ts` moves. The lint rule is per-file and green
today; the wall-clock win for that file arrives with stage 5.

The **api zone is not on the rule yet**, and its substrate use is a
different shape from domain's: the image-build rows the webapp renders
(`api/events`, `api/routes/images`), the proxy client behind the auth and
allow-host routes, the port-forward routes, and the project rebuild/push
routes. None of that is worktree lifecycle, so none of it is covered by
stages 4–5; it wants its own pass over what belongs on the contract (an
image-build feed, a datapath surface) rather than being forced through the
worktree verbs. Stage 8 makes that decision and flips the zone.

**Also moved:** `worktreeForkFallback` left `runtime/k8s/worktrees/changes`
for `domain/worktrees/fork-branch.ts`. It reads the checkout's own git
config host-side and never touched the substrate; its tests now mock
`#platform/git`, the real process boundary.

---

### Stage 5 is in: the launch

`create.ts` no longer names a substrate. It went 1598 → 1349 lines, with
the substrate half now `runtime/k8s/worktrees/launch.ts`, and keeps what
it always should have:
the checkout leg and its failure race, config resolution, image and env
DECISIONS, allowed-host resolution, init windows, records writes, and the
retry/rollback policy. `domain/skills/builtin.ts` and
`domain/worktrees/spawn-script.ts` changed one type import each
(`PodMount` → contract `WorkspaceMount`). The holdout list is gone.

**Six verbs, not the two this plan sketched.** Each extra one keeps a
behavior that folding it into `launch` would have changed:

- **`prepareSubstrate(intent) → WorkspaceSubstrate`** is the big one. The
  cluster leg runs CONCURRENTLY with the image build and the checkout
  (a vcluster cold start is deliberately overlapped), ONCE per create
  rather than per attempt, and its failures surface before any unit
  exists — outside the retry loop and its rollback. Folding it into
  `launch` would have serialized it, re-run it per attempt, and routed
  its failures through the rollback. So domain still orchestrates the
  overlap (that is create-latency policy) and the receipt keeps the
  leg's products — proxy ClusterIP, transport token, vcluster mounts and
  env — opaque above the runtime.
- **`ensureBuildEngine`** preserves the fail-before-any-row podman check.
- **`prepareImage`** collapses `ensureImage` + `pushImageShared`, which
  domain always called back to back. It lives in
  `runtime/k8s/images/workspace-image.ts`, a SIBLING of build-coordinator
  rather than more surface on it, so the CLI test's partial mock of that
  module still intercepts (ESM intra-module calls bypass `vi.mock`).
  `adoptWorktreeForwarders` sits in its own `forwarders/adopt.ts` for the
  same reason.
- **`startForwarders`** takes the pre-bound sockets. Reservation stays in
  domain (`#platform/port` is not restricted), because binding early is
  what stops another process taking the port, and a create that gives up
  must CLOSE them rather than start relays.

**Failed launches reuse `destroy`; no retract verb.** `destroy` gained
`unitOnly`, which takes down what is running and leaves what a relaunch
reuses — the egress registration (made once, in `prepareSubstrate`) and
the vcluster whose kubeconfig is already written to disk. What it protects
is receipt coherence, NOT nested-cluster state: every stop and restart
takes the full path, and what a give-up leaves standing is collected by
the vcluster orphan sweep once it ages out.
Two callers want exactly that: a failed attempt that is about to be
retried, and a create that gave up while KEEPING its checkout (a resume,
a spare) and so stays restartable onto it.
A fresh create that gave up owns everything it made, so it takes the full
`destroy` — which also fixes a leak: that path used to erase the row and
checkout while stranding the proxy registration and vcluster with nothing
naming them. The verdict still gates the checkout removal, and the
per-attempt kubectl call pattern is unchanged (one apply, one delete).

Domain never derives the unit name: `launchWithSetup` reports the handle
through an `onLaunched` callback the moment `launch` returns, so the
teardown target exists even when the failure lands several steps later.

**Two relocations.** `default-allowed-hosts.ts` became
`packages/server/src/lib/allowed-hosts.ts` (`#lib/allowed-hosts`) — every
reader is inside the server package (the proxy learns each workspace's
resolved hosts over the registration wire), so `@yaac/shared` would have
been wrong. `src/lib/` is the new home for dependency-free vocabulary any
layer may name, enforced by an eslint zone that lets it import nothing but
`@yaac/shared` and node builtins. `buildStatusRight` moved to
`#runtime/agents` beside the other tmux vocabulary.

**Testing.** `test/runtime/k8s/worktrees/launch.test.ts` covers both verbs
at the kubectl boundary (labels including the acp/prewarm conditionals,
driver-injected env, the SSH tunnel wiring, priority-classes-before-apply,
the nested/vcluster branches, and that a vcluster found already running is
never re-slept); `ssh-transport` and `workspace-image` have their own.
`teardown.test.ts` gained a `unitOnly` describe. The CLI's
`worktree-create.test.ts` — the real create coverage — keeps every
assertion and changed only its seams: it installs the REAL k8s launch
verbs through `installFakeWorktreeRuntime`, so what it exercises is
exactly the code that turns a create into a Job. One assertion moved from
`toHaveBeenCalledWith(jobName)` to reading the first argument, because a
driver delegation passes its optional second argument through.

**What the test-time win actually was.** Nothing measurable for
`create.test.ts` and `spare-pool.test.ts`, and the reason is worth
recording: `#runtime/agents` binds the stream relay directly, so any
mediator needing agent vocabulary still loads the cluster client
transitively. The lint rule proves no mediator NAMES a substrate barrel,
not that its module graph is cluster-free. Putting the dial on the
contract is what would finish it, and that wants a second driver to
justify it. The decoupling did show up in the module graph, though:
`pnpm modularity` CCD 356 → 345, NCCD 2.16 → 2.02, propagation cost
26.0% → 23.9%.


## Stage 6 — dissolve platform

`platform/k8s` becomes `runtime/k8s/substrate` and `platform/container`
becomes `runtime/k8s/container` — two sealed folders like their new
siblings, with `imports`-map entries and `SEALED_FOLDERS` additions to
match. Stage 5 already did the hard part: outside `runtime/` and
`platform/` itself, the only importers left are `main/convergence` and
`main/runtime-k8s`, both composition-root code that rule 1 permits. So
that half is mechanical — specifier updates, the server `exports` map
(`./platform/k8s/*` and `./platform/container/*` entries repoint; the CLI
and the test tree import several), and no behavior.

The six non-k8s files do not stay behind as a rump layer, and they do not
move as a group: trace where each one's consumers sit after stages 5–8
and every file has exactly one natural home.

- **`streaming-proc.ts` → a `runtime/k8s` module.** It is the child-process
  runner for `podman build`/`push` and `kubectl exec` into builder pods,
  and its only importers are `platform/container` and `runtime/k8s/images`
  — both inside `runtime/k8s` once this stage lands.
- **`port.ts` splits at its own seam.** `reserveAvailablePort` and
  `ReservedPort` go to `src/lib`: reserving early is create policy, and
  after stage 5 domain's create imports exactly those (the relays ride the
  contract's `startForwarders`). The relay engine — `startPortForwarders`,
  `RelayProcess`, `RelayFactory` — goes to `runtime/k8s`: its only
  consumers are the substrate's exec-tunnel and stream-relay and the
  forwarders folder.
- **`shell.ts`, `keyed-mutex.ts`, `build-context.ts` → `src/lib`.** All
  three already satisfy lib's zone (nothing but `@yaac/shared` and node
  builtins): a POSIX quoter and one promisified `execFile`, a pure
  promise-chain mutex, and the build-context file walk whose own header
  says two features answer to it and neither owns it. Each is consumed
  from both sides of the domain/runtime line, which is what lib is for.
  This does widen lib's charter from "name-only vocabulary" to
  "dependency-free vocabulary and host primitives" — the eslint zone that
  enforces it is unchanged, and that zone is the substance.
- **`git.ts` → `domain/git.ts`** (`#domain/git` via the `#*` catch-all,
  like `#runtime/driver`). It has NO runtime consumers — its importers
  are four domain folders, `store/projects`, and one api route — and it
  cannot go to lib (it wraps the `simple-git` npm dep). It is domain's
  process boundary the way kubectl is the driver's: fork-branch already
  mocks it as such. The move happens WITH stage 7, not here — while
  `store/projects` still exists, its `branches.ts`/`credentials.ts`
  imports would point upward at domain — so stage 6 leaves `platform`
  holding `git.ts` alone, and the store dissolution deletes the folder.
  (`ResolvedGitCredential`'s "resolved in `#domain/projects`, consumed by
  the git primitives" comment survives intact; both ends are then in
  domain.) A side effect: the api route's `remoteBranchExists` import
  becomes `#domain/git`, which stage 8's rule already permits.

The rejected alternative, for the record: a `runtime/host` folder holding
all six. It fails three ways. That name belongs to the future second
driver — this plan's own hypothetical is "a host-process driver", and
`runtime/host` is where it would live; squatting a box of primitives on it
would make the contract story harder to tell, not easier. It would put
`git.ts` — which no runtime code imports — inside runtime, so domain would
import runtime for something that is not runtime vocabulary, widening rule
2's exception list for nothing. And it would keep pretending the six files
are one thing, when the consumer graph says they are three.

## Stage 7 — dissolve store between domain and runtime

`store` exists as a sibling layer so that both domain (above) and the
driver (beside) can read disk, which is why the layer diagram carries a
sanctioned sideways edge (runtime → store; the records → store edge is
already gone — records speaks rows alone, and domain resolves the
project-relative transcript column via `absoluteTranscriptPath`). With the
contract real, each piece has exactly one natural owner, and dissolving
the layer deletes the last sideways edge from the diagram. Three moves,
in increasing order of substance:

- **`store/worktrees` → `domain/worktrees`.** Only domain consumes it, and
  stage 5 already declared checkout staging domain policy. `seed`,
  `meta-import` and `session-starts` become internals of the sealed
  folder whose callers (create, cleanup, the agent-session registry) are
  already there. Purely a move.
- **`store/transcripts` → `runtime/agents`.** The per-tool readers pair
  one-to-one with the claude/codex/pi drivers, which already import them;
  the JSONL scanner and the project-relative path convention go along.
  Domain's readers (`agent-session-registry`, `stopped-list`) switch to
  `#runtime/agents` — runtime vocabulary, permitted by rule 2. Purely a
  move as well.
- **`store/projects` → the disk half of `domain/projects`**, and this one
  is design work, because eight runtime files still read it. Their
  dispositions, by kind:
  - `git-auth-failures.ts` is proxy data-plane state — a write-through
    file the egress proxy owns and a replaced proxy re-reads — so it moves
    INTO `runtime/k8s/egress` beside `blocked-hosts`. Its two readers
    split the way that pair already did: `observe.ts` stays
    runtime-internal, and `domain/worktrees/detail` gets a contract read
    beside `blockedHosts`, which crossed this exact bridge in stage 4.
  - Config WRITES issued from the driver (`addAllowedHostToProjectConfig`
    in `egress/allow-host`, `addPortForwardToProjectConfig` in
    `forwarders/forward-port`) move up: persistence is policy. Both flows
    are api-triggered and become domain verbs in stage 8 anyway — the
    mediator persists the config, then calls the runtime verb that
    effects it (push the allow-list, start the relay). The driver stops
    writing project config entirely.
  - Config and credential READS in driver code stop being reads and
    become arguments, the pattern stage 5 set with `WorkspaceSpec`:
    the registration payload carries the credential material
    (`listSshEntries` / `writeProxySecrets` callers), `prepareImage`
    takes the resolved build-dir/dockerfile paths
    (`image-engine/image-builder`), and the boot-time forwarder restore
    and the prewarm sweep (`forwarders/restore`, `images/image-prewarm`)
    take a domain-provided config accessor through `PassContext`, exactly
    as `projectSlugs()` and the default tool are handed down today.

  Do the first two subfolders first; they are unblocked now. The
  `store/projects` half should land as its own PR (or several — the
  argument-threading can go verb by verb), and the `./store/*` `exports`
  entries repoint with it (only tests and test-utils import them). This
  is also the PR that moves `git.ts` to `domain/git` — stage 6 left it as
  `platform`'s last file because `store/projects` imported it — which
  deletes the `platform` directory outright.

## Stage 8 — flip api to domain and records only

Stage 4 deferred the api decision; this stage makes it, and makes it
STRICT: an api file may value-import only `#domain/*`, `#records`, its own
`#http`/`#routes` internals, `#lib`, and `@yaac/shared` — not
`#runtime/driver`, not `#runtime/agents` or `#runtime/terminals`
(`#platform` and `#store` no longer exist by this stage). Type imports of
`#runtime/contract` stay legal (it is import-free vocabulary, and domain
signatures already speak it).

Why strict rather than "api may use the driver like domain does": the
contract's verbs are lifecycle-shaped, while api's residual needs are
display-shaped, and letting routes call the driver directly is standing
pressure to grow display verbs on the contract one at a time. Fronting
them in domain keeps that pressure in the mediators, makes domain the
complete use-case API of the server (routes become translation over one
surface, testable against `installFakeWorktreeRuntime` plus rows), and
means no route can quietly accumulate policy again.

The migrations, enumerated from today's imports:

- `routes/worktrees.ts`: its `worktreeRuntime()` calls, `typeInitialPrompt`,
  the PTY verbs (`createShellWindow`, `killWindowTerminal`,
  `listWorktreeTerminals`), `allowWorktreeHost` and the port-forward pair
  become `domain/worktrees` verbs. The terminal and prompt façades are
  thin by design; allow-host and forward-port are the stage-7 verbs that
  persist config and then effect it.
- `routes/auth.ts`: the proxy client and the credentials store move behind
  `domain/auth`, which already fronts half of this surface.
- `routes/projects.ts`, `routes/config.ts`, `routes/build-files.ts`: the
  `#store/projects` reads/writes become `domain/projects` calls (stage 7
  moves the code; this stage moves the callers), `remoteBranchExists` is
  already legal once stage 7 lands git at `#domain/git`, and rebuild/push
  land as domain verbs over the stage-5 image verbs.
- `routes/images.ts` and `events.ts`: the image-build feed
  (`listImageBuilds`, `getImageBuildLog`, `dismissImageBuild`,
  `retryImageBuild`) is the one genuinely new surface. It goes ON the
  contract, fronted by a domain façade — the same call `blockedHosts` and
  `virtualClusterStatus` took in stage 4, for the same reason: a second
  registered seam with its own fake buys nothing at this size. If display
  verbs keep accumulating past the feed, that is the moment to split the
  seam, and the stage-4 note stands. The snapshot hub keeps its shape;
  `buildSnapshot` just gathers the feed through the façade.

Enforcement, same ratchet as stage 1: put the api variant of
`NO_SUBSTRATE_ABOVE_RUNTIME` (widened to ban `#runtime` value imports
outright) on the api zone with a holdout override naming
today's files, shrink it per PR, delete it at the end. Then the mirror
rule lands: `#runtime/k8s/**` importable only from
`packages/server/src/runtime/**` and `packages/server/src/main/**`.

Optional, separable, unchanged from before: fold `main/convergence`'s
cluster wiring (`ClusterCache` construction, delta fan-out, priority
classes, deferred boot arming, relay invalidation) behind
`runtime.start()` / `runtime.stop()`. Main composes the concrete driver,
so leaving convergence k8s-aware breaks no rule; do this only if the
wiring starts duplicating for a second driver.

## The layer diagram, after stages 6–8

```
main       api
   ↓        ↓   (api: domain and records only)
      domain
   ↓        ↓
records   runtime    records: rows alone
                     runtime: the contract, its drivers; k8s sealed inside
```

Three strata, no sanctioned sideways edges, with `#lib` (dependency-free
vocabulary and host primitives) below everything and `#log`/`#notify` as
the arrow-exempt outbound channels. `platform` and `store` are gone as
layer names; `docs/layered-server.md` is rewritten at each stage so it
keeps describing the present tense.

## Deliberately out of scope

`runtime/agents`, `runtime/status`, and `runtime/terminals` keep their
direct bindings to the stream relay (`podExec`, `dialCtrlStream`,
`dialPtyStream`) — they are runtime-internal, the tui/acp drivers already
take an injectable `dial`, and rule 1 permits it. A true second driver
would need the dial transport on the contract too; that extension has an
obvious seat beside `exec` but no payoff until such a driver exists.
(Stage 8 moves api's PTY routes behind a domain façade, but the façade
calls `#runtime/terminals` — the relay bindings themselves stay where
they are.) Sinking spare-pool's retool/rebranch sequences into
`runtime/agents` is a possible later refinement, not part of this plan.

## Verification per stage

- `pnpm lint` and `pnpm modularity --runtime-only` stay green; the holdout
  list shrinks in the same PR as each migration.
- Domain test wall-clock drops at stage 1 and again at stage 4; migrated
  files' tests must pass with no k8s stub registered. Stage 5 measured no
  further drop — see "Stage 5 is in" for why (`#runtime/agents` keeps the
  cluster client in any mediator that needs agent vocabulary).
- E2e is the behavioral backstop: worktree-create-suite, vcluster-suite,
  worktree-prewarm, worktree-spawn and the stop/cleanup paths exercise
  every moved verb against a real cluster, and none of their assertions
  should change — this refactor moves code across a boundary and must not
  change what the substrate sees.
- Stage 6 is a pure move: lint and `pnpm modularity --runtime-only` green,
  and since the `exports` map repoints, a CLI smoke (`yaac cluster check`)
  proves the out-of-package importers still resolve.
- Stage 7 moves each subfolder's tests with it (`test/store/<name>/` →
  the mirror of its new home); coverage answers "is this internal still
  exercised?" before any test is dropped. `pnpm modularity` should show
  the runtime → store folder edges disappear rather than reappear as
  runtime → domain (which would be a rule violation, not a metric
  regression).
- Stage 8's backstop is the api project (`pnpm vitest run --project api`):
  routes change their imports, not their behavior, so its assertions
  should not change. The holdout list shrinks in the same PR as each
  route migration, as in stages 1–5.
