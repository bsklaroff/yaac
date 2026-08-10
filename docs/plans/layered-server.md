# Dissolving the herd boundary into a layered server

The herd/server split (phases 1–2 of the now-deleted herd-split plan) was
built so the herd could one day be its own process — a JSON-RPC peer, on
another machine. That destination has been dropped: yaac's unit of deployment
is the whole server (an "instance" — store, database, API and runtimes
together, one per place), so there will never be a wire inside this package,
and the boundary's remaining scaffolding is indirection with no payoff ahead
of it.

What the split *discovered* is worth keeping — and this plan keeps it by
moving it somewhere structural:

- **The event inversion.** Code that observes the substrate or the disk does
  not write rows; it reports discrete past-tense events, and one place applies
  them. That stays, enshrined in `#records` (step 4) rather than in a link.
- **The write disciplines.** Whole-set reports (never deltas), fill-only
  prompt capture, "absence of a report is not an empty set", and the reaper's
  same-pass desired-set rule all survive verbatim.
- **The severing itself.** No byte-touching module imports the database. That
  work is what makes this refactor mostly mechanical: the piles are already
  separated, and we are re-sorting them, not untangling them.

What goes: the `#herd` facade and its one-implementation contract, the
`#server-link` mirror, the two hand-maintained path lists in eslint, and the
pretense that half the package is a different program. What replaces them: a
**layered layout** whose import arrows form a DAG, enforced by a handful of
one-line lint rules instead of enumerated files. `pnpm modularity` currently
reports one 24-module cycle costing 558 of 784 CCD; the exit criterion for
the whole plan is that the cycle is gone.

## The target layout

```
main       composition root: startup, shutdown, the reconcile loop
api        routes/, http/, the snapshot hub (main/events.ts today)
  ↓
domain     worktree lifecycle, discovery sweeps, the reaper, spawn policy,
           project lifecycle, titles — everything that MEDIATES
  ↓      ↓       ↓
records  store  runtime     records: rows; the only importer of #platform/db
  ↓       ↓       ↓         store: worktrees/clones/transcripts/config on disk
        platform            runtime: how agents run (k8s driver today)
```

Arrows only point down. `store` and `runtime` are mechanical: they never read
rows and never decide policy — `domain` reads records, drives store and
runtime, and applies what they report. Two package-root modules stay exempt
from the arrows, as `#log` already is: `#notify` (the zero-dependency
outbound "something changed" channel — exactly the role it was designed for
before `#server-link` fenced it off) and `#log` itself.

Inside each layer the existing sealed-folder machinery is unchanged: barrels,
`imports`-map entries, one `describe` per barrel function. Folders move;
their seals move with them. Import specifiers follow the layer
(`#features/images` → `#runtime/images`), updated mechanically per move.

## The event inversion, enshrined (the invariant)

> Observed facts enter `#records` through exactly one door:
> `applyWorktreeEvent` (today `applyHerdEvent`). A module that watches the
> substrate or reads the disk emits an event; it never calls a row mutator.
> Intent (a title, a pin, a preference, project add/remove) is written by
> `domain` through ordinary records functions. Reads are free to all of
> `domain` and above.

Enforced structurally, not by review:

- The per-event mutators the apply function fans out to
  (`linkAgentSession`, `markWorktreeStopped`, `setBaseBranch`, …) become
  **internal to `#records`** — dropped from the barrel, reachable only
  through apply. Today they are exported beside it; that is the door this
  step closes.
- The event union moves from `@yaac/shared/herd` into `#records` (it is
  consumed nowhere outside the server package), keeping its doc comments:
  whole-set semantics on `sessions-discovered`/`sessions-active`, fill-only
  first prompts, "absence is emphatically not an empty set", the
  project-relative transcript-path rule, `MAX_PROMPT_LENGTH`.
- The reaper's discipline survives without the push machinery. With the link
  gone, `stale-worktrees` (domain) reads the desired set through a records
  helper **inside the same reconcile pass** — same-pass consistency now holds
  by construction instead of by a publish step ordered before the reap. The
  provisioning shield rides the same helper. `#herd-desired`,
  `pushDesiredWorkspaces` and the `DESIRED_SET_TRIGGERS` coupling retire.

Naming follows docs/naming.md ("worktree" is the sandbox unit, "session" is
the agent conversation): `HerdEvent` → `WorktreeEvent`, `applyHerdEvent` →
`applyWorktreeEvent`, `HerdReport` → `RuntimeReport`, `WorkspaceReport` →
`WorktreeRuntimeReport`, `WorkspaceHandle` → `RuntimeHandle`,
`DesiredWorkspaces` → `DesiredWorktrees`. "Herd" disappears from the tree.

## Where every module lands

The HERD_SRC/SERVER_SRC lists in eslint.config.js are the split's
classification; this is the re-sort. Unlisted `platform/` modules stay put.

**records/** ← `features/records` whole (worktree-store, agent-session-store,
project-store, preferences, apply-herd-event, desired-workspaces), plus the
event types from `@yaac/shared/herd`.

**store/** — disk mechanics, no rows, no substrate:
- `store/projects` ← the projects disk half: branches, build-dirs,
  build-files, config, credentials, dockerfile, fake-auth, git-auth-failures,
  local-config.
- `store/worktrees` ← seed, worktree-meta, changes, project-purge.
- `store/transcripts` ← `features/agents/transcripts.ts`, `jsonl.ts`.
- `store/skills` ← `features/skills` (reads skill dirs out of the clone).

**runtime/** — how agents run:
- `runtime/contract.ts` — the `WorktreeRuntime` driver interface, carved from
  `herd/contract.ts`: a mandatory core (provision, teardown, observe, find,
  attach streams) plus optional capability modules (`images`, `egress`,
  `ports`, `spares`, `nested`) whose absence is type-checked, not thrown.
  The report types move here beside it.
- `runtime/status` ← `features/status` (handle-keyed observation core —
  already substrate-neutral, shared by every future driver).
- `runtime/terminals` ← `features/terminals`.
- `runtime/agents` ← `features/agents` minus the transcript readers: drivers,
  control-mode, the acp-* modules, agent-command, agent-tools,
  setup-commands.
- `runtime/k8s` — the first driver, absorbing the k8s-only features whole:
  `cluster`, `egress`, `forwarders`, `images`, `image-engine`, plus the
  worktrees files that act on the substrate: observe, locate, spare-pool,
  spawn-script, salvage-reconcile, prewarm, prewarm-reconcile.

**domain/** — the mediators (may import records, store, runtime):
- `domain/worktrees` ← create, restart, stop, cleanup, resolve, list, detail,
  fork-branch, stopped-list, project-teardown, provisioning, prompt-capture,
  agent-session-registry (the discovery sweep), stale-worktrees (the reaper),
  spawn-reconcile, and `main/spawn.ts` (`decideSpawn` — spawn policy is
  domain, not composition).
- `domain/projects` ← add, detail, list.
- `domain/titles` ← `features/titles`.
- `domain/auth` ← `features/auth` (judgment call — it touches token files;
  reclassify to store at carve time if it turns out to be pure disk).
- `domain/reconcile` ← the merged step list (see "flattening" below).

**api/** ← `routes/`, `http/`, and `main/events.ts` (the snapshot hub).
**main/** keeps server.ts, server-run.ts, webapp.ts, lifecycle.ts, and the
reconciler *loop* (`startReconciler`), whose step list comes from domain.

**Deleted**, not moved: `herd/contract.ts`, `herd/current.ts`,
`herd/in-process.ts`, `herd/index.ts`, `server-link.ts`, `main/link.ts`,
`herd-desired.ts`, `@yaac/shared/herd.ts` (contents relocated). The two
substantial herd modules are absorbed: `herd/reconcile.ts`'s steps into the
flat list, `herd/lifecycle.ts`'s attach/stop-convergence/release into
`main/lifecycle.ts` (moving into `runtime` when the contract lands).

Known judgment calls, decided at carve time with the arrows as the test:
the per-tool descriptor modules (claude.ts, codex.ts, opencode.ts, pi.ts)
are vocabulary consumed by both `runtime/agents` and `store/transcripts` —
they land wherever keeps store from importing runtime, likely a zero-IO
vocabulary module at platform level; and `create.ts` interleaves
orchestration with pod mechanics — it stays whole in domain first (domain may
import runtime), and the provision half sinks into `runtime/k8s` only when
the driver contract needs it.

## Dissolving `#server-link`

Each of its four methods becomes a direct call, and each caller's new layer
makes the import legal:

| Link method | Becomes | Callers (all → domain) |
|---|---|---|
| `workspaceEvent(e)` | `applyWorktreeEvent(e)` from `#records` | create, cleanup, prewarm, agent-session-registry, stale-worktrees |
| `workspacesChanged()` | `notifyWorktreeListChanged()` from `#notify` | those plus `image-engine/image-builds` (stays runtime — `#notify` is arrow-exempt) |
| `spawnRequested(r)` | `decideSpawn(r)` from `#domain/worktrees` | spawn-reconcile |
| `recordedConversations(w)` | a records read in the domain caller, or delivered as an argument where the caller is runtime-side — resolved at the dissolve step | the ACP watcher-start path |

`DETACHED` (inert no-link mode) and `_setServerLinkForTests` disappear; unit
tests that installed a partial link mock `#records`/`#notify` at the same
seams instead.

## The lint regime

All five split constructs (`HERD_SRC`, `SERVER_SRC`, `NO_DATABASE`,
`NO_SERVER`, `NO_HERD_FEATURES`) retire. In their place, one rule per layer —
globs over `src/<layer>/**`, no enumerated files:

- Everywhere except `records/`: no `#platform/db`, `@electric-sql/pglite`,
  `drizzle-orm`, and no `#records`'s internal modules past the barrel (the
  existing sealed-folder rule already covers the latter).
- `runtime/**` and `store/**`: no `#records`, `#domain`, `#api`, `#main`;
  additionally `store/**`: no `#runtime`, and `runtime/**`: no `#store`.
- `domain/**`: no `#api`, `#main`.
- `#notify` and `#log` importable from any layer.

The lists only shrink at the end; during the carve, each move step deletes
the moved paths from the old lists and relies on the new layer rule, so the
boundary never goes unenforced mid-flight.

## Flattening the reconciler

Today one pass is three server steps, the middle one being the herd's own
thirteen. The flat list preserves the exact order and trigger semantics:

1. `stale-worktrees` (was fed by the desired-set publish; now reads the
   desired helper directly, same pass) — `DESIRED_SET_TRIGGERS` + poll
2. `spawn-requests` … `orphan-modules-gc` — the herd steps in their current
   order, with their current triggers, sharing one `TickSnapshot`
3. `generated-titles` — after the agent-sessions sweep, same reason as today
   (a just-captured opening message is eligible in the same pass)

The `defaultTool` argument threading stays (it is a preference row; runtime
steps still receive it rather than reading it). Step error isolation and the
abort-before-each-step contract are unchanged. No behavior change is
intended anywhere in this plan; the e2e suites are the check that holds.

## Steps

**Steps 1–7 have landed**; step 8 (the local driver) is the open follow-on.
Each step lands green (`pnpm lint`, unit, and the e2e suites — this refactor
is exactly the "pure refactor, cluster required to trust it" case) and moves
test files alongside their subjects (`test/` mirrors `src/`).

### 1. Charter and citations

This document replaces docs/plans/herd-split.md; delete it. Repoint every
citation of it (grep finds them in `platform/db/schema.ts`, the worktrees
feature, `test-utils/server.ts`, `shared/herd.ts`, `docs/naming.md`,
`docs/worktree-storage.md`, `test/e2e-cli/worktree-prewarm.test.ts`, and
throughout `src/herd/`) at this plan or at the invariant section above.
Delete the stale `origin/server-reads-herd-reports` draft branch.

*Exit:* no reference to herd-split.md remains.

### 2. Dissolve `#herd`

Replace every `herd().<group>.<method>(…)` call with a direct import of the
function `in-process.ts` wraps (callers: the worktree join files, the routes,
`main/events.ts`, `main/reconciler.ts`, `main/server-run.ts`). Merge
`herd/reconcile.ts`'s steps into the reconciler's flat list;
absorb `herd/lifecycle.ts` into `main/lifecycle.ts`. Delete `src/herd/`,
the `SERVER_SRC` zone and `NO_HERD_FEATURES`. `HerdStub` in test-utils gives
way to mocking the same functions at their new import sites.

*Exit:* `src/herd/` is gone; e2e green.

### 3. Dissolve `#server-link`

Apply the table above. Delete `server-link.ts`, `main/link.ts`,
`herd-desired.ts`; retire the desired-set push in favor of the records
helper the reaper calls in-pass. Replace `HERD_SRC` + `NO_DATABASE` with the
interim global rule "only `#features/records` imports `#platform/db`" until
step 7 installs the full layer regime.

*Exit:* `#server-link` and `#herd-desired` resolve nowhere; lint green.

### 4. Enshrine the events in `#records`

Move the event union and desired-set types from `@yaac/shared/herd` into
`#records`; move the report/handle types into the future
`runtime/contract.ts` (created now, contract carved in step 5). Rename per
the naming table. Seal the per-event mutators behind `applyWorktreeEvent` —
off the barrel, internal only. Delete `@yaac/shared/herd.ts`.

*Exit:* records' barrel exposes reads, intent writes, and exactly one
observed-fact write: `applyWorktreeEvent`.

### 5. Carve `runtime/`

Create `src/runtime/` with the driver contract; move `status`, `terminals`,
the driving half of `agents`, and the k8s-only features + worktree substrate
files into `runtime/k8s`. Update the `imports` map and `SEALED_FOLDERS`;
install the runtime layer rule. The contract starts as a description of what
the k8s driver already does — capability modules split out here, but no
second driver is written in this plan.

*Exit:* runtime layer rule active; nothing under `runtime/` imports records,
store, or domain.

### 6. Carve `store/`

Move the projects disk half, the worktree disk pieces, the transcript
readers, and skills. Install the store layer rule. This is where the
tool-descriptor judgment call is made.

*Exit:* store layer rule active.

### 7. Carve `domain/` and `api/`

Move the mediators and the joins; move routes/http/events under `api/`;
`decideSpawn` from main to domain; land the merged reconcile step list in
`domain/reconcile`. Delete the last path lists; the full layer regime from
"The lint regime" is now the only boundary machinery in the file.

*Exit:* `pnpm modularity` shows the server-package cycle gone (NCCD toward
tree-like from 5.81); every eslint boundary is a layer glob, none a file
list.

### 8. Follow-on (not this plan): the local driver

The payoff the layering buys: a `runtime/local` driver — host tmux on a
dedicated socket, provision = spawn, observe = directory scan plus
`tmux has-session`, no images/egress/spares modules — giving unsandboxed
zero-cluster worktrees behind the same contract. Charter separately once
step 7 lands.

## Risks worth naming

- **The reconciler flattening is the subtle one.** Step order, trigger sets,
  the shared snapshot, and the desired-set/reap same-pass rule must survive
  the merge exactly; the reaper destroys uncommitted work when wrong. The
  existing reaper and reconciler unit tests carry over and gate the step.
- **`create.ts` is the deepest cut** — orchestration interleaved with pod
  mechanics. The plan defers its split (domain may import runtime), so no
  step depends on getting it right under time pressure.
- **Churn and conflicts.** Steps 5–7 move whole folders; in-flight branches
  will conflict. Land 2–4 first (small, high-value), schedule 5–7 for a
  quiet window, one folder per commit.
- **The CLI imports cluster features directly** (`cluster-setup/check/delete`
  run before any server exists). Their specifiers update with the moves —
  mechanical, but easy to forget since they live outside `packages/server`.
- **Unit tests that installed a partial `ServerLink`** re-mock at records and
  notify. The seams are narrower than the link was; a test that gets harder
  to write here is a signal the call site landed in the wrong layer.
