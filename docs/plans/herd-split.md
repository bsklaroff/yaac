# Splitting the herd out of the app server

Today one Node process is the API, the database, the cluster controller, and
the data plane for every session. This plan splits it in two:

- the **server** — HTTP/WS for clients, the PGlite database, and every fact a
  client can ask about;
- the **herd** — the Kubernetes cluster and its lifecycle, the git worktrees
  and repo clones, the tool homes and their transcripts and ACP records, the
  in-pod tmux sessions, image builds, and the live connections into all of it
  (control-mode streams, ACP conversations, PTYs, port forwards).

The two talk **JSON-RPC**, bidirectionally, over one link. **The herd never
opens the database.** PGlite is single-writer and the server holds it, so this
is a hard constraint rather than a style rule: the day the herd is a separate
process, any DB read it still has is a crash.

## The invariant

> The herd owns **bulk bytes and live runtime state**. The server owns **every
> durable fact a client can ask about**. Facts the herd discovers are
> *reported*; the server persists them. Data the herd needs is *delivered*; it
> never looks it up.

Two consequences do most of the design work:

- **Discovery inverts.** `createSession` writes `worktrees` and
  `agent_sessions` rows today; the registry reconciler imports the in-pod
  hook's link tree; the prompt capture parses transcripts into rows. All three
  become *emitters*: the herd has the bytes, so it parses them and says what it
  found, and the server writes the row.
- **Lookups invert.** The stale reaper reads recorded rows to know what should
  exist; restart reads the conversation links to know what to relaunch. Both
  become inputs the server hands down.

## What is deliberately NOT in scope

The draft branch (`origin/server-reads-herd-reports`) reached for the endgame in
one move — multiple herds, capability negotiation, substrate-agnostic nouns, an
encrypted secrets table, a WebSocket transport with identity, epoch fencing and
reconnect backoff — and got tangled before the database was even severed. Those
are all real, and all deferrable. This plan defers:

- **more than one herd**, placement policy, and `HerdCapabilities`;
- **a non-Kubernetes herd** as a second implementation;
- **a remote herd**, and with it herd credentials, epoch fencing and reconnect
  (steps 17–18, after the split has landed);
- **encrypted credentials in the DB**, CRDs, and level-triggered spec
  application for create.

What is kept from the draft: the `WorkspaceReport` shape and the
observe/join split of `listActiveSessions` (step 5) are the parts that were
right, and the report vocabulary stays free of Kubernetes nouns because that
costs nothing now and is expensive to retrofit.

## Two decisions that keep this small

**Verbs stay verbs.** Create, restart, stop and claim are JSON-RPC *calls* with
progress notifications, not edits to a desired-state document. State comes back
up as a whole-herd report. The one place level-triggered desired state earns its
keep is the stale reaper (step 6), which genuinely needs "what should exist"
rather than "what was just asked for".

**The first transport is a pipe, not a socket.** The server spawns the herd as a
**child process and speaks JSON-RPC over stdio** — no port, no token, no TLS, no
reconnect logic, no fencing. The codec is transport-agnostic, so the WebSocket
transport a remote herd needs is a later, additive step that introduces
auth and fencing *alone*, when nothing else is moving.

## Phase 1 — sever the database (steps 1–9)

**Landed.** The exit test holds: no module that touches the cluster, a
worktree, a transcript or tmux imports the database, and `HERD_SRC` in
`eslint.config.js` is what keeps it that way.

Everything here is in-process. No protocol, no second process, no behavior
change a user can see. The phase's exit test: **no module that touches the
cluster, a worktree, a transcript or tmux imports `#platform/db`**, enforced by
lint rather than by discipline.

### 1. The ratchet

Add an eslint zone (`HERD_SRC` + `NO_DATABASE` in `eslint.config.js`)
forbidding `#platform/db` and the driver packages beneath it from a declared
list of herd-side paths, seeded with the modules that are *already* clean:
`#platform/k8s`, `#platform/container`, `#features/cluster`,
`#features/images`, `#features/image-engine`, `#features/egress`,
`#features/status`, `#features/terminals`, `#features/forwarders`,
`#features/agents`.

A module severed out of `#features/sessions` needs a second ban
(`NO_ROW_STORES`), because the row stores still live in that folder and are
reached from it by relative path, where `NO_DATABASE` cannot see them. It
retires in step 7, when they move out and get a specifier of their own.

The ratchet catches DIRECT imports only. A module in the zone can still reach
the database through a barrel that re-exports something which touches it — see
step 9, which is where that gap gets closed rather than papered over.

Nothing to fix — the diff is `eslint.config.js` plus this doc. Its value is that
**every later step ends by adding a path to that list**, so the boundary can
only move one way and a reviewer can see the progress bar in one file.

`#features/agents` belongs there despite having grown a lot: its own barrel
already declares it knows nothing about a session, a pod or the database, and
the live ACP conversation registry it now holds is herd runtime state by
definition.

### 2. The event channel

Define `HerdEvent` in `@yaac/shared/herd` — a union over
`worktree-created`, `worktree-create-failed`, `base-branch-resolved`,
`sessions-launched`, `sessions-discovered`, `sessions-active`
and `worktree-stopped` — and a server-side `applyHerdEvent(event)` that performs exactly the writes those call
sites perform today. Discrete and past-tense on purpose: this is what the herd
*found*, applied once to a row, as against `#features/status`, which is the
continuous "what is this agent doing right now".

The channel itself is a zero-dependency module at the package root, for the
same reason `#notify` is one — it became `#server-link` in step 11, where it
grew the rest of the herd→server traffic. The report is **awaited**, and the
server resolves only once the row is written: a listing between the report and
the write would show a worktree as neither running nor stopped. Over a link
that stays a call. An event whose ordering does not matter can be relaxed to a
notification later, per event and on purpose.

Convert one call site to prove the shape: `cleanup.ts`'s
`recordWorktreeStopped`. Small, self-contained, and it is the mechanism every
later step reuses. The union grows one variant per severed call site, so its
membership stays a live statement about what has actually stopped writing rows
rather than a design sketch.

*Exit:* `cleanup.ts` joins the zone.

### 3. Create and prewarm-claim emit events

The worktree row, the resolved base branch, the launched conversations and the
failure rollback all become events, in `createSession` and in
`tryClaimPrewarmed`. Emission keeps today's *timing* — the row appears before
anything is provisioned, not at the end — so the webapp's provisioning
behavior is unchanged.

The rollback is the interesting one, and it is where the invariant pays. A
failed create means one thing to a herd and two things to the server: a fresh
worktree is erased, a resumed one is put back exactly as the restart found it,
death cause and dismissal included. So the herd emits only
`worktree-create-failed`, and the server keeps the stop it is about to clear —
read and cleared adjacently inside the `worktree-created` handler, where
nothing can observe the row in between, which is tighter than the two separate
steps this replaces.

*Exit:* `create.ts`, `prewarm.ts` and `spare-pool.ts` join the zone
(`spare-pool.ts` was already clean).

### 4. Conversation discovery emits events

The sweep reports the **full per-worktree set** so the server does the diffing,
and prompt capture folds into it. The old capture pass took its work list from
a query — "which conversations still lack a prompt" — and the only ways to
sever that were to duplicate the sweep or to merge the two, so the reconciler
loses a step and the sweep gains the opening message. Reading a prompt is gated
on a herd-local set, so it happens once per conversation per herd life; the
server's write is fill-only, which is what makes re-reporting after a restart
a no-op rather than a clobber.

Both discovery sources are already herd-side, and they are asymmetric in a way
that helps: under `tui` the history is the in-pod hook's link tree, but under
`acp` the server *is* the ACP client, so `session/new` hands back the id as a
return value.

opencode is the case to be careful with. It has no link tree and leaves no host
transcript, so nothing discovers it — its rows come only from create, and the
old capture pass reached them through the database. Severing that removes its
prompts entirely unless the sweep is given an explicit exemption from the
"evidence required before recording a pinned conversation" rule, on the grounds
that for opencode the evidence can never exist.

*Exit:* `agent-session-registry.ts`, `prompt-capture.ts` join the zone.

### 5. The worktree report

Split `listActiveSessions` in two:

- `observeWorkspaces()` — herd-side: pods, runtime classification, the status
  store, forwarded/unforwarded ports, blocked hosts, per-agent liveness.
  Returns a `HerdReport`.
- the server-side join — adds only what a herd cannot answer: title, background
  pin, recorded creation time, captured prompt, and the project-existence check.

`#features/titles` then reads the joined list and stays server-side (it writes a
row and runs a model; neither is herd work), which also takes it off the herd's
reconcile loop.

The largest single step in the phase, and the one that decides the report
vocabulary. Worth its own review — though half that decision is already made:
the status store keys a conversation's busy/idle by the driver's opaque
**handle** rather than by a tmux pane id, so the liveness half of the report is
substrate-neutral before it is written down.

That handle is what settles the shape. The report carries liveness keyed by
handle and says nothing about conversations, because WHICH conversation sits on
a handle is a row the herd never sees. Putting the two back together is the
join's whole job.

*Exit:* the observation half of `list.ts` joins the zone.

### 6. Desired set for the reaper

`stale-sessions.ts` reads `listLiveWorktreeRows`/`listStoppedWorktreeIds` to
know what *should* be running. The server instead pushes that set (`#herd-desired`)
as its own reconcile step ordered before the reaper, so absence is only ever
judged against a set from the same pass; the reaper compares it against runtime
and reports deaths as events.

The tri-state liveness rule survives intact and gets a new edge: a herd whose
link is down has said nothing about its workspaces, so nothing may be reaped and
nothing may list as stopped. Which is why "nothing has been pushed" reads as
`undefined` and stands the sweeps down, never as an empty set — an empty set
would condemn every running workspace at once.

*Exit:* `stale-sessions.ts` joins the zone.

### 7. The last row reads, and the stores move

Each of these is a few lines:

- `restart` — the server resolves the target and the conversations to relaunch
  and passes them down; the herd stops reading `worktree_agent_sessions`.
- `resolve.ts` — row-based resolution moves server-side; the herd keeps only
  pod matching.
- `detail.ts` — the captured-prompt fallback becomes a server-side read.
- `stopped-list.ts` — already pure metadata; moves server-side.
- `project-teardown.ts` — splits into row deletion (server) and byte deletion
  (herd).

Then the finish: **the row stores move into `#features/records`**, a sealed
feature that is the server's half of a worktree and the only one allowed to
open the database — so `NO_ROW_STORES` retires and `NO_DATABASE` bans that
barrel instead. The sessions barrel's pass-through re-exports go with them: a
second door onto records would let a herd module reach the database through it.

`#features/sessions` ends up split down the middle rather than wholly
herd-side. Sixteen modules join the zone; the joins that read rows alongside a
herd's report — list, detail, resolve, restart, changes, the stopped listing,
project teardown — are the server's half and stay out. Separating them
physically belongs with the package extraction (step 17), not here.

### 8. Projects become rows

Add a `projects` table (+ drizzle migration). `listProjects`, `getProjectDetail`,
`ensureProjectExists`, `removeProject`, and `addProject`'s duplicate check read
rows instead of scanning `~/.yaac/projects/*/project.json`, with a
non-one-shot adoption shim so existing installs and any directory that appears
later are picked up.

Independently valuable regardless of the split: it is what stops the server
enumerating a directory to answer an API call.

### 9. Config, credentials and preferences flow as data

This is the step that closes the gap the zone cannot see on its own. Lint
catches only DIRECT imports, so a module in the zone could still reach the
database through a barrel that re-exports something which touches it — which is
exactly what `#features/projects` did, by housing `preferences.ts`.

- **Preferences move to `#features/records`.** They were never project state:
  the default tool, the shortcut rebinds and the migration flags are all
  server rows that happened to live in the projects feature. Moving them is
  what frees the projects feature's *modules* of the database, so its disk
  half can join the zone at all.

  The BARREL is still an open door, and knowingly so: `#features/projects`
  re-exports `addProject`, `getProjectDetail`, `assertProjectExists` and
  `listProjects`, each of which reads rows, so a herd-side module importing
  that barrel for credentials or config still loads the database graph
  behind it. Lint cannot see it, and the day the herd is its own process
  every one of those imports is the crash this plan is about. Closing it
  means splitting the feature the way step 7 split sessions; until then it
  is the largest known gap in the zone, not an oversight.
- **The default tool reaches the herd as an argument.** The prewarm pool and
  the spawn reconciler resolved it themselves; the server now resolves it once
  per pass and hands it down.
- **Project config** — the in-repo `yaac-config.json` lives inside the clone,
  so its resolution is already herd work. Nothing to move: it becomes an RPC in
  step 10 like every other herd call.
- **Git credentials** — already herd-owned files on the substrate's disk, which
  is the recommendation the plan made and the status quo both. What is left is
  the remote-herd question (an ssh secret stores a *path* the herd would have
  to resolve), and that belongs with step 18, not here.

`#features/projects` ends up split like `#features/sessions`: the disk half in
the zone, and `add` / `detail` / `list` — which answer "which projects exist"
from rows — out of it.

## Phase 2 — one interface, one channel (steps 10–11)

**Landed.** Both exit tests hold: `src/herd/in-process.ts` is the only module
under `packages/server/src` that imports a herd feature, and no herd module
imports `#main`, `#routes`, `#http`, `#notify` or `#herd`. `SERVER_SRC` and
`NO_SERVER` in `eslint.config.js` are what keep it that way.

Still one process. What the phase bought is that swapping in a remote
implementation touches one file.

### 10. `HerdClient`

`#herd` carries every server→herd call — create/restart/stop/claim, observe,
changes, branches, resolve-config, open-terminal, open-port, the cluster and
image entry points — grouped by what it acts on, with an in-process
implementation that calls today's functions and decides nothing.

Two shapes in it are still in-process-only, and named as such: the
`onProgress` callbacks a create carries, and the sockets a PTY or ACP attach
borrows. Both become addressed calls over the multiplex (steps 13–14);
neither changes the interface's membership.

The lifecycle is the part worth a reviewer's attention. `attach` owns
everything convergence-owning — informer caches, status watchers, the port
detector, the cluster bootstrap, the startup GCs — and fires `onAttached`
when it is really attached, which a nested server defers until first use so
its born-at-zero vcluster stays asleep. The server starts its reconcile loop
from that callback rather than from the return, because a loop running
against a sleeping vcluster is the same mistake as starting the caches.

The reconciler splits the same way. The herd runs its own ordered steps over
its own view of the substrate; what is left in `#main` is the two steps that
touch rows, bracketing it — the desired set published before the reaper can
judge an absence against it, and titles generated after the conversation
sweep. Title generation therefore runs at the end of a pass rather than in
the middle of one, which is the only observable behavior change in the phase.

*Exit:* exactly one module imports the herd features.

### 11. `ServerLink`

The mirror image, and `#herd-events` grown up: the event sink, the
change notification and the queued-spawn report become one interface at the
package root, so the herd half is built against a link rather than against
`#notify`, the provisioning registry and `applyHerdEvent`.

`spawn-reconcile` stops calling `createSession` itself. It drains the proxy's
queue and resolves who called from pod labels — the only two things on its
side of the boundary — and reports; the server validates, applies the tool
precedence and the fan-out cap, mints the id, registers the sidebar row and
drives the create. The provisioning registry moves out of the zone with it,
being a server concept throughout.

One lookup survives in the other direction: `recordedConversations`, which an
ACP driver needs to re-address a live agent it did not start. It is a row, so
it is asked for rather than read.

The in-flight set goes the other way. The reaper and the orphan-dir sweep
both need to know which workspaces the server is still creating — it is the
only thing standing between them and a create's staged directories — and they
were reading the provisioning registry directly, which lint cannot see
because it is a relative import inside the same folder. It rides down on
`DesiredWorkspaces` instead: one push, one discipline, and nothing to
re-plumb when the herd is a package that cannot see the registry at all. The
orphan-dir sweep moves onto the reconcile loop for the same reason — it needs
a set that only exists once a pass has published one — and self-gates to once
per herd life, so it is still the startup sweep it always was.

*Exit:* herd code imports nothing from `#main`, `#routes`, `#http`, `#notify`.

### Two behavior changes, declared

Title generation runs at the END of a pass rather than in the middle of one.
It is still after the conversation sweep, which is the whole reason the
ordering existed.

`project remove` deletes the bytes before the rows, where it deleted rows
first. The old order left a failed `fs.rm` with the project vanished and its
bytes orphaned; the new one leaves it intact, listed, and retryable, and the
window in between self-heals on the retry. The reversal is deliberate.

### What phase 2 costs

`#herd` joins the server package's existing import cycle rather than
resolving it, because both halves still live in one package: the join paths
call down through `#herd`, and its in-process implementation calls back into
the features they sit above. `pnpm modularity` says so — one more module in
the tangle, NCCD 5.65 → 5.81. Step 17 is what fixes it: once the herd is
`packages/herd`, the edge runs one way and pnpm's strict `node_modules`
enforces it by construction.

## Phase 3 — make it a process (steps 12–16)

### 12. Promote the JSON-RPC peer, add a frame multiplex

Most of this step is already written. `acp-jsonrpc.ts` is a bidirectional
JSON-RPC 2.0 peer over a newline-delimited stream, correlating ids and
dispatching incoming calls in both directions, behind a four-method
`JsonRpcTransport` seam — and it knows nothing about ACP. Promote it out of
`#features/agents` into a platform module both users share, before it accretes
anything ACP-shaped.

What has to be built is the layer *beneath* it: a frame multiplex carrying a
stream id and a kind, whose control stream satisfies `JsonRpcTransport` and
whose other streams are byte pipes. Base64ing forwarded bytes into JSON would
cost a third again on every dev-server response, so the two kinds stay separate.
Unit-tested by driving `HerdClient` and `ServerLink` against each other over an
in-memory pair.

The herd ends up a JSON-RPC peer on both sides — the server above it, acpd
below. They stay separate protocols: ACP is a spec yaac does not own, and only
the transport is shared.

### 13. Streams over the multiplex

Three kinds cross the boundary, and they are usefully different:

- **Port forwards** — opaque bytes, so the pipe *is* the protocol. The clearest
  statement of what the others' framing is actually for.
- **PTY attach** — needs exactly one extra bit per frame (keystrokes vs. control
  JSON). `attachPty` itself does not change; the route's job shrinks to
  translation.
- **`/acp/attach`** — the easiest, because its frames are already JSON messages
  in a closed union. Both of its inputs are herd-side already: the tail of the
  host-mounted record, and a borrowed live `AcpConversation` from the registry.

Still one process.

### 14. Progress and borrowed connections

create/restart progress travels as notifications correlated to the call id; the
NDJSON route and the provisioning registry are fed from them.

This is also where the last things the server holds *by reference* into the herd
have to go: the `onProgress` callback handed into `createSession`, and the
`AcpConversation` (and tmux control stream) a route borrows from a registry to
deliver a prompt. A borrow is exactly what a socket cannot carry, so each
becomes an addressed call — the registry stays herd-side and the server names
the conversation instead of holding it.

### 15. `yaac herd serve`, spawned as a child

The server forks the herd, pipes stdio, and speaks the codec. Convergence
ownership moves with it — informer caches, status watchers, the port detector
and the reconcile loop all start in the herd process, on one rule: **whoever
runs a herd reconciles.** Two processes converging one cluster is not a degraded
mode, it is mutual reaping, so ownership is positional rather than negotiated.

Ship it behind a flag (`YAAC_HERD=child|inprocess`) so both paths run in CI for
one release. The exit test is an e2e that asserts two PIDs and drives a full
session lifecycle through them — in-process tests structurally cannot catch the
bugs this step introduces.

### 16. Flip the default, delete the in-process path

The server supervises the child: restart on unexpected exit, drain on shutdown,
and a report gap that reads as `unknown` rather than as death.

## Optional follow-ons

### 17. Extract `packages/herd`

A mechanical move once the boundary has no violations. pnpm's strict
`node_modules` then makes the database unreachable by construction rather than
by lint, and the herd image stops carrying PGlite. Large diff, zero logic — the
easiest big review in the sequence. The CLI's `yaac cluster check/setup/delete`
commands, which run before any server exists, import it directly.

### 18. Remote herd over WebSocket

Now, and only now: `/herd/connect`, a herd-kind token that is not a client
token, herd identity minted into the data root, epoch fencing so two processes
cannot serve one byte store, and reconnect with backoff. A second transport
behind the same codec, introduced with nothing else in flight.

Only after this does "the server on a laptop, the herd in the cluster" work,
and the remaining blockers are the shared-filesystem assumptions step 9 leaves
in place: credential paths, and worktree paths that appear in call arguments.

## Risks worth naming

- **e2e is the only real check.** Steps 5, 7 and 15 change the shape of the
  session list, the restart path and the process model; the e2e suites need a
  cluster and must stay green at every step.
- **The reaper is the destructive one.** A link blip must read as `unknown`.
  Reaping on transport failure destroys uncommitted work that exists in no
  other copy.
- **Step 4 is the subtlest.** Reporting a partial conversation set where the
  server diffs against the whole would silently unlink live conversations; the
  report has to be complete per worktree, and the tests have to say so. Two
  discovery sources with different shapes (a link tree, a handshake reply) make
  a partial set easy to produce by accident.
- **Both agent modes have to be exercised at every step that touches
  conversations** — 3, 4, 5 and 7. `tui` and `acp` differ in where history
  comes from, what a handle is, and how a prompt is delivered, and a test suite
  that covers one proves nothing about the other.
