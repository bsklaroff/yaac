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
                            store: worktrees/clones/transcripts/config on disk
                            runtime: how agents run (k8s driver today);
                            its substrate is sealed inside it
```

`lib/` sits below all of it — dependency-free vocabulary and host
primitives that name nothing back.

Arrows only point down. Two package-root modules are exempt from the
arrows: `#log`, and `#notify` — the zero-dependency outbound "something
changed" channel. Anything may emit on `#notify`; only the api layer's
snapshot hub listens, so a change notification is not a dependency on the
hub that consumes it.

One sideways edge is sanctioned, and it is one-way. A runtime driver may
read the store — it mounts what the store staged, launches with the config
and credentials the store keeps, and the per-tool transcript readers are
store code its agents module shares — and the DAG holds because the store
never reads back.

`records` reaches nothing sideways at all. A column that names a place on
disk holds the store's portable form (a transcript path is
project-relative, so it stays true wherever the data dir sits); resolving
one against the project directory takes layout knowledge, so it happens a
layer up, in `absoluteTranscriptPath`. That keeps rows a vocabulary the
records layer can speak alone.

## What lives where

- **`main/`** — `server-run` (lock, DB open through records' lifecycle,
  bind, attach — and the one place the process's runtime is registered),
  `runtime-k8s` + `runtime-k8s-steps` (the k8s `WorktreeRuntime`, assembled
  from the sealed folders; here rather than under `runtime/k8s` because
  assembling it means importing all of them, and they import the contract),
  `convergence` (informer caches, per-worktree status watchers, the port
  detector — everything push-fed; it also translates substrate deltas into
  the pass's trigger vocabulary), `reconciler` (the pass engine; its step
  list comes from domain, which splices in the runtime's own), `server`,
  `webapp`, `lifecycle`.
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
  substrate, nothing above it.
- **`runtime/`** — `contract.ts` (the `WorktreeRuntime` driver interface
  and its substrate-neutral vocabulary: `RuntimeReport`, `RuntimeHandle`,
  handle-keyed `AgentLiveness`, `RuntimeSnapshot`, the launch types —
  `WorkspaceSpec`, `WorkspaceMount`, `SubstrateIntent` and the opaque
  `WorkspaceSubstrate` receipt — and the pass scheduling types),
  `driver.ts` (the registered instance, behind `setWorktreeRuntime` /
  `worktreeRuntime`), `status/` (control-mode watchers feeding the status
  store), `terminals/` (PTY bridge), `agents/` (the tui/acp drivers,
  acpd's JSON-RPC client, per-tool launch commands), and `k8s/` — the
  driver's substance: `cluster`, `egress`, `forwarders`, `images`,
  `image-engine`, `worktrees` (launch, observe, locate, claim, teardown,
  the pod-side changes diff, image salvage), `view` (the one mapper
  turning a pod into a `RuntimeHandle`, plus the pass snapshot), and the
  two host-side primitives the rest of them are built on — `substrate`
  (client, informers, exec, pod specs, the per-pass `TickSnapshot`, the
  datapath's names and ports) and `container` (podman, the local
  registry, the streaming child-process runner). `k8s/` holds sealed
  folders only; nothing loose sits beside them. The contract is the seam
  a second driver — a host-process runtime with no cluster —
  implements.

  `contract.ts` and `driver.ts` import nothing but shared types, and that
  is load-bearing: a mediator reaching the runtime through them pulls no
  cluster client into its module graph. Every mediator now does — no
  domain file names a substrate barrel, enforced outright. The remaining
  transitive edge is `#runtime/agents`, which binds the stream relay
  directly (`podExec`, `dialCtrlStream`), so a mediator needing agent
  vocabulary still loads the cluster client; putting the dial on the
  contract is what a second driver would justify.

  The launch is the shape to read first, because it is the one verb whose
  split is not obvious. `prepareSubstrate` runs ONCE per create and
  stands up what belongs to the WORKSPACE (its egress registration, the
  project registry, a virtual cluster with its own state), answering with
  an opaque receipt; `launch` runs per ATTEMPT and applies a unit and
  nothing else. That is what makes a retry cheap and safe — a failed
  attempt leaves only a unit, and `destroy`'s `unitOnly` takes exactly
  that down while leaving what the next attempt reuses.
- **`lib/`** — the server's own dependency-free vocabulary AND host
  primitives: modules every layer may name and that name nothing back —
  the egress allowlist's defaults and matching, a POSIX quoter and one
  promisified `execFile`, a promise-chain keyed mutex, TCP port
  reservation and the relay engine that forwards through one, and the
  build-context file walk. A sink in the module graph, so importing one
  costs a layer nothing — its zone allows node builtins and `@yaac/shared`
  and nothing else, third-party deps included, which is what keeps that
  true. Distinct from `@yaac/shared`, which is for vocabulary other
  PACKAGES read; nothing outside this package reads these.
- **`platform/`** — `git.ts` alone, and only until the store dissolves:
  it wraps the `simple-git` dep, has no runtime consumers, and is
  domain's process boundary the way kubectl is the driver's. It moves to
  `domain/git.ts` with `store/projects`, which deletes the directory.

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

## The push path

> Every store the snapshot reads notifies at its own mutation site, and
> the api layer's hub is the only thing listening.

`buildSnapshot` gathers rows, the informer cache, the provisioning and
image-build registries, the status store, the forwarder registry and the
port detector, the plan-usage cache, and the two files the egress proxy
write-throughs. Each of those announces its own changes on `#notify`; the
hub coalesces the burst, rebuilds, diffs against what it last sent, and
broadcasts only a difference. Nothing else publishes — routes translate
and return, and the reconciler knows nothing about snapshots.

One rule, so a new writer never has to ask how its change reaches a
browser: **if you mutate something `buildSnapshot` reads, notify there.**
`applyWorktreeEvent` covers every observed fact at the event door;
intent writers (a title, a pin) notify individually.

The consequence worth keeping: an idle server rebuilds nothing at all.
The only clock left on this path is the plan-usage refresh, which is
genuinely irreducible — the upstream usage endpoints have no push — and
is gated on a client being connected.

## The reconcile pass

`main/reconciler.ts` is the engine — two lanes (watch deltas and a 60s
resync) feeding one serialized, debounced pass executor with per-step
error isolation. There is no poll lane: every source has an edge, and
the resync is what makes losing one cost latency rather than
correctness — the same bet the informer's relist makes. Beyond the cache
deltas the edges are `live-agents` and `status-streams` (in-pod facts,
from the driver connections) and `spawn-requests` / `proxy-reconnect`,
which the egress proxy reports over the event stream described below.
`domain/reconcile.ts` is the ordered step list:
the stale reaper first (so counts reflect just-reaped worktrees by the
time the prewarm pool runs), the conversation sweep, and title generation
last, so a just-captured opening message is eligible in the same pass.

The runtime contributes its own steps — its GCs and datapath heals — in
two groups the mediators splice in: `prePool` before the spare pool sizes
itself, `maintenance` after the sweeps that read rows. Those are the only
two orderings the mediators have a stake in; what the runtime's steps
sweep, and how they order among themselves, is substrate detail and is not
named in `domain/reconcile.ts`.

Steps share one `RuntimeSnapshot`, created lazily — the first triggered
step takes the view and every later step sees the same instant. Its
`workspaces()` and `strayUnits()` come off one memoized substrate view, so
"a unit with no workspace" is never a comparison across two instants,
which is what makes the reaper's destructive sweep safe. The runtime's own
steps recover the fuller substrate view from the same object.
The configured default tool is a preference row, resolved through a lazy
per-pass accessor and handed down so no substrate step reads a row; a
FAILED read rejects the accessor and stands down exactly the steps that
needed the answer, while an unset preference falls back to claude. The
project list is handed down the same way, so a runtime step never reads a
row itself.

The reaper reads `desiredWorktrees()` from records at the top of its own
step, so absence is only ever judged against a set from the same pass, by
construction. A failed read stands every sweep down — reaping on a guess
destroys uncommitted work — and the in-flight exemption comes straight
from the provisioning registry, which is populated synchronously before a
create stages anything.

## The proxy event stream

Three facts the server needs are visible only inside the egress proxy: a
worktree's blocked-host set growing, a git credential being rejected
upstream (the proxy MITMs the git exchange, so pods never hold the
credential and only it sees the rejection), and an in-worktree
`yaac-spawn` landing in its queue.

The proxy cannot dial the server — it is an in-cluster pod, the server is
a host process with no in-cluster address, and nested the server sits
inside a pod of the *outer* cluster. So the signal rides the connection
the server already holds: one long-lived `GET /events` over the control
tunnel, NDJSON, consumed by `ProxyEventStream` in `#runtime/k8s/egress`.

The events carry no state. `/data/blocked-hosts.json` and
`/data/git-auth-failures.json` stay the data plane — they are also how a
replaced proxy comes back knowing this state — and the spawn queue keeps
its own claim protocol. Every event means only "look again", and a
reconnect re-fires all of them, so a dropped stream costs latency, never
a lost update. That reconnect is also the only edge that says the proxy
pod may have been replaced, which is what the ssh-agent heal and the
vcluster-attribution re-push hang off.

## Naming

Per docs/naming.md: a **worktree** is the sandbox unit; a **session** is
an agent conversation; **workspace** survives only in the runtime
contract's substrate-neutral vocabulary. The event union and its apply
function say "worktree" (`WorktreeEvent`, `applyWorktreeEvent`); the
observation types say "runtime" (`RuntimeReport`, `RuntimeHandle`).
