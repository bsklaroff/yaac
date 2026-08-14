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
domain     the mediators: everything that reads rows, owns what a project
           and a worktree keep on disk, and drives the runtime
 ↓             ↓
db           runtime       db: rows; owns the database outright
               ↓           runtime: the driver-neutral machinery — how
             drivers                 agent sessions are conducted,
                                     observed and attached to
                           drivers: contract.ts + driver.ts, and one
                                    sealed folder per substrate (k8s)
```

`lib/` sits below all of it — dependency-free vocabulary and host
primitives that name nothing back.

Three strata, and no sanctioned sideways edges: arrows only point down.
Two package-root modules are exempt from them: `#log`, and `#notify` — the
zero-dependency outbound "something changed" channel. Anything may emit on
`#notify`; only the api layer's snapshot hub listens, so a change
notification is not a dependency on the hub that consumes it.

Everything below domain is one of two things, which is the property worth
protecting: rows, or the runtime, fronted by a contract. Neither reads the
other.

The runtime is itself split, and the split is the seam each driver
implements. `runtime/` is what is the same over any substrate — the
tui/acp conduction, the status watchers and liveness policy, the PTY
bridge, the report assembly and the forwarder restore. `drivers/` is what
is not: `contract.ts` (the `WorktreeDriver` interface and its vocabulary),
`driver.ts` (the registered instance), one folder per substrate — `k8s/`
(a single-pod Job per worktree) and `containerless/` (a tmux server per
worktree on the host; docs/containerless-driver.md) — and `shared/`, the
floor both stand on.

`drivers/shared` exists because a driver is sealed from its siblings: they
cannot see each other, so neither can host what both need (the review
diff's script and parser, the port-exposure policy). Without it the choice
would be duplicating that or pushing substrate concerns up into `#lib`,
where every mediator would inherit them. The arrow runs driver → shared and
never back, and the lint says so — nothing in `shared/` may import a
driver, and nothing above a driver may import `shared/`. What belongs there
is decided by who calls it: both drivers and nobody else.

Which one a process runs is the composition root's single call, made from
`env.driver` before anything can ask for one. Everything above branches on
at most `driver.kind`, and only to decide WHETHER a feature applies —
never how it is realized. Most callers need no branch at all: the contract
specifies per verb what a runtime that lacks a feature answers (empty,
`null`, a resolved no-op), so an absent feature degrades rather than
failing.

Command text is the one place a substrate used to leak through. Every
tmux invocation, `git -C` call and prompt script the layers above author
is written against `WorkspacePaths` — the driver's answer to where a
workspace's things are in its own world. A pod driver answers with fixed
container paths, because each pod has its own mount namespace; a
host-process driver answers per-worktree, because its workspaces share a
filesystem and a single tmux socket between them would be a single tmux
server.

The arrows there run downward, which reads backwards until you see what
holds it up: `runtime/` imports the contract, and so does every driver,
and only `main` imports a driver at all. The call-time flow — a mediator
asks the machinery, which asks the driver — travels through the registry
in `driver.ts`, the same inversion `#notify` uses. So a driver folder is
reachable from exactly one place, and nothing that runs over it can name
it.

A driver has ONE door: `#drivers/k8s` or `#drivers/containerless`, the
assembly. What is behind it is internal — the k8s driver's nine sealed
folders, the containerless driver's flat modules — and the eslint rule
says so: `#drivers/<kind>/*` is importable only from inside `drivers/`,
with `main` naming the assemblies alone. (One exception: the substrate-admin
commands import through the package's `exports` map —
`drivers/k8s/cluster/{check,setup,delete}` and
`drivers/containerless/check`, which back `yaac cluster …` and `yaac host
check`. Administering a substrate is substrate-specific by nature, so that
door stays open and is governed by the pnpm boundary rather than a zone.)

Api reaches the runtime on the same terms as the mediators and the
machinery: `#drivers/driver` and `#drivers/contract`, never a concrete
driver. Three layers hold the accessor, and the rule that matters is the
one they share — nothing above a driver names a substrate.

What separates them is composition, not permission. A read that resolves a
worktree, decides something from what it finds and then acts is a
mediator's, and lives in `#domain` — `dismissWorktreePort` refuses a port
the runtime is not offering, `getWorktreeChanges` picks the fork branch as
the diff's default base. A display value the runtime already holds, asked
for once and rendered, is not: the image-build feed and the ssh-identity
push are api calling the contract directly, because a mediator that only
forwarded the call would hide the seam rather than mediate it. The line is
invisible to lint on purpose. A wrapper whose body is `return
worktreeDriver().x(...)` is worse than the call it hides, and the one
verb in `#domain/images` is there because it cannot be one: a retry has to
hand the runtime a config reader, and the runtime may not read config.

That shape is what decides where a disk read goes, and the answer is never
"the runtime looks it up". A driver is HANDED what it needs — a launch
intent carries the resolved config and the secrets it must deliver, a
reconcile pass hands down the project list and each project's config, and a
credential reader the proxy needs on its own schedule (an attach, a
reconnect heal) is composed in at startup. So the driver's own file reads
are confined to its datapath: the two files it write-throughs with the
egress proxy, and the images it builds.

`db` reaches nothing sideways at all. A column that names a place on disk
holds a portable form (a transcript path is project-relative, so it stays
true wherever the data dir sits); resolving one against the project
directory takes layout knowledge, so it happens a layer up, in
`absoluteTranscriptPath`. That keeps rows a vocabulary the db layer can
speak alone.

## What lives where

- **`main/`** — `server-run` (lock, DB open through `openDb`,
  bind, attach — and the one place the process's driver is registered),
  `convergence` (what is push-fed and is NOT the driver's: the
  per-worktree status watchers, which are machinery needing a row lookup,
  and the two in-workspace trigger sources no watch of any substrate can
  see — a conversation appearing, a driver connection dropping. The
  driver's own attach lives behind `start`/`stop`/`release`, and reports
  back through `DriverSinks`), `reconciler` (the pass engine; its step
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
  registry, the stale reaper, and what a worktree keeps on disk: checkout
  seeding and the in-pod hook's session-starts log), `projects/` (a project
  whole — which exist, from rows, and what each one holds on disk: the
  clone's branches, the two config layers, git credentials, dockerfiles and
  build files), `git/` (the `simple-git` process boundary, domain's the
  way kubectl is the driver's), `images/` (one verb: a build retry, which
  hands the runtime the project-config reader it may not fetch),
  `titles/`, `auth/`, `skills/`, and `reconcile.ts` — the ordered step list
  one pass runs.

  Config and credentials sit here rather than a layer down because writing
  them is policy: a persisted allowed-host or port forward is inherited by
  every future worktree of the project, and the verb that persists one then
  asks the runtime to effect it live.
- **`db/`** — the worktree, agent-session and project stores,
  preferences, token persistence, `desired-worktrees` (what the reaper
  judges absence against), the database's open/close pair, and the event
  machinery below. The database is its own: `client.ts` (the PGlite
  handle) and `schema.ts` (the drizzle tables) are internal modules here,
  off the barrel, so no other layer can name a table or build a query.
  What the rest of the server gets is `openDb`/`closeDb` and
  the row functions; the driver packages are eslint-banned everywhere
  else.
- **`runtime/`** — the driver-neutral machinery, four sealed folders:
  `agents/` (the tui/acp drivers, acpd's JSON-RPC client, per-tool launch
  commands, and where each tool keeps its transcript — the per-tool
  readers pair one-to-one with the drivers, so the file layout and the
  path convention live with the grammars), `status/` (the control-mode
  watchers feeding the status store, the liveness probes and their
  caches, workspace classification, the terminating marks, and
  `observeWorkspaces` — the report assembly that joins the driver's raw
  facts with what the watchers saw), `terminals/` (the PTY bridge), and
  `ports/` (the forwarder restore a server restart needs, over the
  contract's `startForwarders`).

  All of it runs over whichever driver is registered, which is the point:
  the containerless driver inherits conduction, observation, attachment,
  report assembly and restore without reimplementing any of it. tmux is
  the supervisor either way (docs/agent-modes.md) — only the transport
  under it differs, and that is on the contract.
- **`drivers/`** — `contract.ts` (the `WorktreeDriver` interface and its
  substrate-neutral vocabulary: `RuntimeHandle`, handle-keyed
  `AgentLiveness`, `RuntimeSnapshot`, the stream types `StreamChild` and
  `StreamPty`, the `WorkspaceExecError` verdict, the launch types —
  `WorkspaceSpec`, `WorkspaceMount`, `SubstrateIntent` and the opaque
  `WorkspaceSubstrate` receipt — and the pass scheduling types),
  `driver.ts` (the registered instance, behind `setWorktreeDriver` /
  `worktreeDriver`), and `k8s/` — the first driver, whose barrel IS its
  assembly (`createK8sDriver`) over nine sealed folders: `cluster`,
  `egress`, `forwarders`, `images`, `image-engine`, `worktrees` (launch,
  locate, claim, teardown, the pod-side changes diff, image salvage),
  `view` (the one mapper turning a pod into a `RuntimeHandle`, plus the
  pass snapshot), and the two host-side primitives the rest are built on —
  `substrate` (client, informers, exec, pod specs, the per-pass
  `TickSnapshot`, the datapath's names and ports) and `container` (podman,
  the local registry, the streaming child-process runner). Nothing loose
  sits beside them.

  The assembly can be the barrel — above the nine folders that import the
  contract — precisely because the contract is its own bucket below them:
  the graph runs assembly → folders → contract → nothing.

  `contract.ts` and `driver.ts` import nothing but shared types, and an
  eslint zone on those two files alone is what keeps it true. That is
  load-bearing twice over: a mediator or a machinery module reaching the
  runtime through them pulls no cluster client into its module graph, and
  a contract that can import nothing cannot quietly grow a dependency on
  the substrate it exists to hide.

  The lifecycle is the driver's own: `start(sinks, deps)` attaches and
  begins watching, `stop()` takes everything push-fed down before the
  reconcile drain, `release()` lets go of what was borrowed from the host
  after it. Resolving `start` does not mean attached — the k8s driver
  defers the whole thing until first use inside a nested yaac, so a
  born-at-zero virtual cluster is not woken by the server living in it;
  `sinks.attached` is the edge that means it, and the reconcile loop
  starts from there. `sinks.recover` fires earlier still, while the
  substrate is usable and nothing is watching, which is when the forwarder
  restore runs. The two directions are separate types on purpose:
  `DriverSinks` is where a driver reports, `DriverDeps` is what it is
  handed (the SSH identity reader it re-reads on its own schedule).

  Two verbs are worth reading for their split. The launch: `prepareSubstrate`
  runs ONCE per create and stands up what belongs to the WORKSPACE (its
  egress registration, the project registry, a virtual cluster with its own
  state), answering with an opaque receipt; `launch` runs per ATTEMPT and
  applies a unit and nothing else. That is what makes a retry cheap and
  safe — a failed attempt leaves only a unit, and `destroy`'s `unitOnly`
  takes exactly that down while leaving what the next attempt reuses. And
  `list`: `preferCache` asks for the driver's push-fed view, which the
  display path takes on every snapshot rather than making the apiserver
  list what a watch is already streaming; a caller needing the substrate's
  own word leaves it off.
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

## The event door

> Observed facts enter `#db` through exactly one door:
> `applyWorktreeEvent`. Code that watches the substrate or reads a
> worktree's disk emits a `WorktreeEvent` — discrete and past-tense — and
> the handler alone decides which rows it lands in. Intent (a title, a
> sidebar group, a preference) is written through ordinary db functions;
> reads are free to domain and above.

The per-event row mutators are internal to db, off the barrel, so a
caller cannot write an observed fact except by saying what happened. The
disciplines that make re-reporting safe live with the event types
(`db/events.ts`):

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
intent writers (a title, a group) notify individually.

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
project list and each project's config are handed down the same way, so a
runtime step never reads a row or a config file itself. A step that runs
outside a pass — the boot-time forwarder restore, the webapp's build
retry — takes the same reader as a plain parameter, since there is no
context to draw one from.

Which of the three a new need takes follows from what triggers it: only
ever reconcile-step-shaped → a `PassContext` accessor; caller-triggered →
a plain parameter; fired on the DRIVER's own schedule, with no caller to
pass anything in → a provider composed at the root (`DriverDeps`). None of
them is a license for the runtime to read rows or config itself.

The reaper reads `desiredWorktrees()` from db at the top of its own
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
`yaac-mama` command landing in its queue.

The proxy cannot dial the server — it is an in-cluster pod, the server is
a host process with no in-cluster address, and nested the server sits
inside a pod of the *outer* cluster. So the signal rides the connection
the server already holds: one long-lived `GET /events` over the control
tunnel, NDJSON, consumed by `ProxyEventStream` in `#drivers/k8s/egress`.

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
an agent conversation; **workspace** survives only in the driver
contract's substrate-neutral vocabulary. The event union and its apply
function say "worktree" (`WorktreeEvent`, `applyWorktreeEvent`).

The **driver** is the thing a substrate implements — `WorktreeDriver`,
`drivers/k8s`, `worktreeDriver()`. The observation nouns keep saying
"runtime" (`RuntimeHandle`, `RuntimeReport`, `RuntimeSnapshot`) and that
is deliberate: there "runtime" means *observed right now*, as opposed to
the durable facts `db` keeps — the split the contract is built on.
`DriverReport` would read as a report about the driver, which is not what
it is.
