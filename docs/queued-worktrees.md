# Queued worktrees

A **queued worktree** (an *entry*) is a worktree create request saved for
later: a prompt plus the full create settings — tool, model, UI mode,
permission mode, reference branch, and optionally a title and a sidebar
group — attached to a **parent**. It runs when
the parent stops *naturally*: a user stop from the webapp or `yaac worktree
stop`, or an agent's `yaac-mama stop`. It does not run when the parent dies
(OOM, crash, eviction, the agent exiting); it waits under the parent until
the user runs or discards it.

The parent is a worktree or **another entry**, so requests chain to any
depth. An entry under an entry waits for its parent to launch *and then*
stop naturally; each link is a full worktree run. Entries are not
worktrees — they have no `worktrees` row, checkout or runtime until they
launch — and the UI never calls them sessions (docs/naming.md). In code,
"queue" already names the proxy's `yaac-mama` request queue, so this
feature's modules and table are `queued-worktree*` / `queued_worktrees`.

## When an entry runs

The release happens in `stopWorktree` and nowhere else, because that
function is exactly the set of natural stops: every user- or agent-requested
stop reaches it, and nothing else that records a stop does — the stale
reaper's teardowns, a restart's teardown, a failed resume and project
removal all go around it. Stop *records* cannot tell these apart (a
`worktree-stopped` event with no cause covers restart teardown and failed
resumes too), so the call site is the trigger.

`stopWorktree` releases once the stop is recorded, not once the runtime is
gone: a child has its own checkout and runtime. All of a parent's direct
children release together and launch concurrently. Exiting the agent
(`/exit`) is a death — the reaper records `agent-exited`, which it cannot
tell from a crash — so an agent that is done calls `yaac-mama stop`.

A stopped worktree with at least one entry is **held**: the sidebar keeps it
as a stopped row, with its death reason if it died, and nests its entries
under it until the last one has launched or been discarded. Restarting a held
parent brings it back with its children still queued for its *next* natural
stop.

## Chains

Only the top of a chain — the entry whose parent is a worktree — can be
released by a stop; an entry never stops, so nothing below can run early.
The parent pointer moves down the chain as it runs:

- **At claim.** The transaction that claims an entry's launch
  (`claimQueuedLaunch`) re-points its children from the entry to the worktree
  id the launch is creating. From then on they are ordinary children of a
  worktree: the sidebar nests them under its provisioning row, and its natural
  stop releases them — even one that comes before the launch has finished.
- **On failure.** `failQueuedLaunch` moves every *unreleased* child of that
  worktree id back under the entry, including ones queued under the
  provisioning row mid-launch. A child the worktree's own stop already
  released keeps its pointer: a release is never taken back. If that child's
  launch then fails too, it points at a worktree whose failed create deleted
  its row — an **orphaned** entry, which the snapshot flags and the sidebar
  shows at the top level.
- **Queueing under a launching entry** (possible by id through
  `yaac-mama queue --worktree`) queues under the worktree it is becoming, and
  the failure rule takes the child back if the launch fails.

## Settings

Every setting is resolved to a concrete value when the entry is queued, so
what the sidebar and the edit dialog show is exactly what will run. They
default from the parent:

- A **worktree** parent supplies its first conversation's tool, mode and
  *current* model (which follows a `/model` switch), its row's permission
  mode and group, and its **reference branch** (`worktrees.baseBranch`, the
  branch it forked from — not its own `agent/<id>` branch). A parent still
  provisioning has no conversation yet, so its provisioning row names the
  tool and group.
- An **entry** parent supplies its stored settings.

A tool other than the parent's takes that tool's create defaults
(`resolveCreate`) for the tool-dependent fields instead. A model the catalog
cannot supply is refused rather than stored empty.

`baseBranch` is recorded with the worktree row at creation — every input
(`options.branch ?? config.referenceBranch ?? getDefaultBranch`) is a local
read — so a parent that is still provisioning supplies its branch. The
`base-branch-resolved` event survives only for a claimed spare's re-branch.
`id=$(yaac-mama create …); yaac-mama queue --worktree "$id" …` can arrive
before even the row: a create in flight under its own id (never a spare
claim, whose worktree lists under the spare's id — which is why `yaac-mama
create` never claims one) resolves as a parent from its provisioning entry,
which carries the branch it asked for.

A queued launch **skips the spare claim** (`claimSpare: false`). Its claim
has already pointed the entry's children at the worktree id it creates
under, and a claimed spare lists under its own id, so they would be left
waiting on nothing. A cold create fetches first, so the child forks from
origin's latest tip of its branch.
Queueing never records the project's create defaults — settings inherited
from a parent are not a choice the user made for the project.

The **group** is decided when the entry is queued, like every other
setting: the parent's unless the request names one (by id, or by name — a
name matching no group creates it, as a create's does) or `null` for the
default list. Moving the parent afterwards leaves the entry
where it was filed; deleting its group returns it to the default list. A
**title** is the user's own and never inherited; the worktree it launches
carries it from the moment its row exists, so the title sweep never
replaces it. Without one, that worktree is auto-titled as any other.

## Launching

A launch goes through `startWorktree`, the one create path (the create route
and `yaac-mama create` use it too), with `rememberDefaults` and `claimSpare`
off. It shows a normal provisioning row and delivers the prompt as any
create does.

- **Claim.** A compare-and-set on `launchWorktreeId` before anything is
  provisioned under that id. A Run-now double-click, or a stop racing the
  reconcile step, loses and does nothing.
- **Success** deletes the entry.
- **Failure** clears the claim and the release, records `launchError`, and
  removes the provisioning row, so the error shows once, on the queued row,
  with the prompt still there.
- **Server restart mid-launch.** The `queued-worktrees` reconcile step is the
  crash backstop. An entry claimed by nothing in this process is put back
  with an "interrupted" error, prompt and children intact, for the user to
  check and run again. It is not guessed at: the workspace exists long before
  a create is done (agent respawned, prompt typed), so a live one says
  nothing about whether the launch finished, and a half-made worktree it
  leaves is the stale reaper's. A release that never launched is launched.
  The step has no triggers: `stopWorktree` launches directly, and the resync
  (the first pass after start is one) is enough.

An entry whose launch is in flight cannot be edited or discarded
(`CONFLICT`), and is absent from the snapshot while its provisioning row
stands in for it.

## Editing, discarding, running now

- **Edit** changes any stored field, including the parent. A parent that is
  the entry or one of its descendants would make a cycle that never runs, and
  is refused. The check walks up from the new parent and steps from a worktree
  that is some entry's launch to that entry: a launching entry otherwise hides
  its ancestry, and a failed launch would close the cycle the walk missed.
- **Discard** deletes the entry and splices its children up to its own
  parent, so the rest of the chain runs one link sooner.
- **Run now** releases one entry whatever its parent is doing. Mid-chain, it
  leaves the chain once its launch succeeds; its children follow it to the
  new worktree.

## Surfaces

- **Routes** (`/worktree/queue/{create,update,discard,run}`) take and answer
  JSON — nothing about queueing is slow, and a Run now's progress is its
  provisioning row. They are the user's, so no permission ceiling applies.
- **Snapshot.** `queuedWorktrees` (entries not launching, oldest first) and
  `heldWorktrees` (stopped rows entries wait on — a slimmer shape than the
  stopped listing, which stats transcripts and is too slow for a snapshot).
  `WorktreeListEntry.permissionMode` lets the create dialog seed a child from
  a live parent.
- **`yaac-mama queue`** queues under the caller, or under the worktree or
  entry `--worktree` names, and prints the entry id so an agent can build a
  chain in a script. Its posture defaults to the parent's and is held to the
  caller's own as a ceiling (docs/permission-modes.md). `yaac-mama list`
  shows entries indented under their parents.
- **Webapp.** One create dialog (Alt+N, a row's `…` menu, a queued row) with
  a **Start** field: `Now`, or after a live worktree or queued entry stops.
  A title set with the pencil beside its heading turns off auto-titling for
  what it creates, and its **Group** follows the Start parent's until it is
  picked. The Group lists the groups the sidebar shows (pinned, or holding a
  live, starting or held worktree), those a queued entry will launch into,
  and "+ New group", which swaps the dropdown for a name box; the create or
  queue brings that group into being. Queued rows nest under their parent
  in the sidebar, each worktree's whole set (chains included) behind one
  collapsible "n queued worktrees" expander. Sets start collapsed; the one
  exception is the set the user just queued or moved an entry into from the
  dialog, which opens so the result shows. The stop dialog lists a worktree's children so
  they can be edited or discarded before they start.
