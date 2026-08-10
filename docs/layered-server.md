# The layered server

`packages/server` is one process organized as layers whose value-import
arrows form a DAG. The boundaries are enforced by per-layer eslint zones
(globs in `eslint.config.js`, so a new file is born into its layer's rules)
plus the sealed-folder barrels; `pnpm modularity --runtime-only` is the
check that the runtime-edge graph stays cycle-free.

```
main       composition root: startup, shutdown, the reconcile loop engine
api        routes/, http/, events (the /events snapshot hub)
  ↓
domain     the mediators: everything that reads rows and drives the
           layers below
  ↓      ↓       ↓
records  store  runtime     records: rows; owns the database outright
  ↓       ↓       ↓         store: worktrees/clones/transcripts/config on disk
        platform            runtime: how agents run (k8s driver today)
```

Arrows only point down. Two package-root modules are exempt from the
arrows: `#log`, and `#notify` — the zero-dependency outbound "something
changed" channel. Anything may emit on `#notify`; only the api layer's
snapshot hub listens, so a change notification is not a dependency on the
hub that consumes it.

Two sideways edges are sanctioned and one-way. A runtime driver may read
the store — it mounts what the store staged, launches with the config and
credentials the store keeps, and the per-tool transcript readers are store
code its agents module shares — and the DAG holds because the store never
reads back. And `records` resolves recorded transcript paths through
`#store/transcripts`, the one place the project-relative column form is
turned back into bytes on disk.

## What lives where

- **`main/`** — `server-run` (lock, DB open through records' lifecycle,
  bind, attach), `convergence` (informer caches, per-worktree status
  watchers, the port detector — everything push-fed), `reconciler` (the
  pass engine; its step list comes from domain), `server`, `webapp`,
  `lifecycle`.
- **`api/`** — `routes/` (translation only; policy lives below), `http/`
  (auth middleware, the in-memory token store, the error envelope, static
  SPA serving), `events.ts` (the snapshot hub: coalesced pushes over
  `/events`).
- **`domain/`** — `worktrees/` (the lifecycle verbs and their joins —
  create, restart, stop, cleanup, list, detail, resolve, the stopped
  listing, project teardown — plus the prewarm pool, spawn policy and its
  proxy drain, the discovery sweeps, prompt capture, the provisioning
  registry, and the stale reaper), `projects/` (add · detail · list,
  row-backed), `titles/`, `auth/`, `skills/`, and `reconcile.ts` — the
  ordered step list one pass runs.
- **`records/`** — the worktree, agent-session and project stores,
  preferences, token persistence, `desired-worktrees` (what the reaper
  judges absence against), records' open/close lifecycle, and the event
  machinery below. The database is its own: `client.ts` (the PGlite
  handle) and `schema.ts` (the drizzle tables) are internal modules here,
  off the barrel, so no other layer can name a table or build a query.
  What the rest of the server gets is `openRecords`/`closeRecords` and
  the row functions; the driver packages are eslint-banned everywhere
  else.
- **`store/`** — `projects/` (the clone's branches, the two config layers,
  git credentials, dockerfiles, build dirs and files), `worktrees/`
  (checkout seeding, and the in-pod hook's session-starts log),
  `transcripts/` (per-tool readers, the JSONL scanner, and the
  project-relative path convention). Pure disk mechanics: no rows, no
  substrate, nothing above platform.
- **`runtime/`** — `contract.ts` (the substrate-neutral observation
  vocabulary: `RuntimeReport`, `RuntimeHandle`, handle-keyed
  `AgentLiveness`), `status/` (control-mode watchers feeding the status
  store), `terminals/` (PTY bridge), `agents/` (the tui/acp drivers,
  acpd's JSON-RPC client, per-tool launch commands), and `k8s/` — the
  driver's substance: `cluster`, `egress`, `forwarders`, `images`,
  `image-engine`, and `worktrees` (observe, locate, the pod-side changes
  diff, image salvage). The contract is the seam a second driver — a
  host-process runtime with no cluster — implements.
- **`platform/`** — substrate primitives with no opinions about worktrees:
  `k8s/` (client, informers, exec, pod specs, the per-pass
  `TickSnapshot`), `container/` (podman, the local registry), git, shell,
  process helpers.

## The event door

> Observed facts enter `#records` through exactly one door:
> `applyWorktreeEvent`. Code that watches the substrate or reads a
> worktree's disk emits a `WorktreeEvent` — discrete and past-tense — and
> the handler alone decides which rows it lands in. Intent (a title, a
> pin, a preference) is written through ordinary records functions; reads
> are free to domain and above.

The per-event row mutators are internal to records, off the barrel, so a
caller cannot write an observed fact except by saying what happened. The
disciplines that make re-reporting safe live with the event types
(`records/events.ts`):

- **Whole sets, never deltas.** `sessions-discovered` carries a worktree's
  full known history; `sessions-active` carries the complete live set, and
  the *absence* of that event is emphatically not an empty set — a watcher
  that cannot see says nothing.
- **Fill-only capture.** An opening message is only ever added, so a sweep
  that re-reads a compacted transcript cannot rewrite one, and a restart's
  re-report is a no-op.
- **Rollback memory.** A failed create erases a fresh worktree but puts a
  resumed one back exactly as the restart found it, death cause and
  dismissal included — the prior stop is read and cleared adjacently in
  the `worktree-created` handler.

## The reconcile pass

`main/reconciler.ts` is the engine — three lanes (watch deltas, a 5s poll,
a 60s resync) feeding one serialized, debounced pass executor with
per-step error isolation. `domain/reconcile.ts` is the ordered step list:
the stale reaper first (so counts reflect just-reaped worktrees by the
time the prewarm pool runs), the substrate sweeps and GCs, the
conversation sweep, and title generation last, so a just-captured opening
message is eligible in the same pass.

Substrate steps share one `TickSnapshot`, created lazily — the first
triggered step takes the view and every later step sees the same instant.
The configured default tool is a preference row, resolved through a lazy
per-pass accessor and handed down so no substrate step reads a row; a
FAILED read rejects the accessor and stands down exactly the steps that
needed the answer, while an unset preference falls back to claude.

The reaper reads `desiredWorktrees()` from records at the top of its own
step, so absence is only ever judged against a set from the same pass, by
construction. A failed read stands every sweep down — reaping on a guess
destroys uncommitted work — and the in-flight exemption comes straight
from the provisioning registry, which is populated synchronously before a
create stages anything.

## Naming

Per docs/naming.md: a **worktree** is the sandbox unit; a **session** is
an agent conversation; **workspace** survives only in the runtime
contract's substrate-neutral vocabulary. The event union and its apply
function say "worktree" (`WorktreeEvent`, `applyWorktreeEvent`); the
observation types say "runtime" (`RuntimeReport`, `RuntimeHandle`).
