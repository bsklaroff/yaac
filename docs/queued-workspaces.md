# Queued workspaces

A **queued workspace** (an *entry*) is a workspace create request saved for
later: a prompt plus the full create settings (tool, model, agent mode,
permission mode, reference branch, and optionally a title and a sidebar
group), attached to a **parent**. It runs when the parent stops *naturally*:
a user stop from the webapp or `yaac workspace stop`, or an agent's
`yaac-mama stop`. It does not run when the parent dies (OOM, crash, eviction,
the agent exiting); it waits until the user runs or discards it.

An entry can also have no parent. It then waits for room in its group, which
must have a workspace limit, and runs once the group has a free slot
(docs/workspace-groups.md). This lets an orchestrator queue many workers
into one group and have at most N run at once.

An entry can instead start at a time, with no parent, then launching once
its group has room. Scheduled starts, the timeout an entry can give what it
launches, and the routines that queue one per cron tick are in
docs/routines.md.

The parent can be a workspace or another entry, so requests chain to any
depth. An entry under an entry waits for its parent to launch and then stop
naturally. Entries are not workspaces: they have no `workspaces` row,
checkout or runtime until they launch, and the UI never calls them sessions
(docs/naming.md). This feature's modules and table are `queued-workspace*` /
`queued_workspaces`.

## When an entry runs

Entries are released in `stopWorkspace` and nowhere else. That function is
exactly the set of natural stops: every user- or agent-requested stop goes
through it, and nothing else that records a stop does (the stale reaper, a
restart's teardown, a failed resume, project removal). Stop records can't
tell these apart, so the call site is the trigger.

Release happens once the stop is recorded, not once the runtime is gone,
since a child has its own checkout and runtime. All of a parent's direct
children launch together, as far as their groups have room. A released
child whose group is full waits for room from then on, like an entry with
no parent: it keeps its release, and launches when any slot in its group
frees, not at its parent's next stop. An agent exiting (`/exit`) counts as a death, since
the reaper records `agent-exited` and can't tell it from a crash, so an agent
that is done should call `yaac-mama stop`.

A stop that lands while the parent is still being created or restarted is
not a natural stop and releases nothing, since the parent's agent never ran
(docs/draft-workspaces.md). A stopped restart keeps its children waiting
for its next natural stop. A stopped create is rolled back, so the children
queued under it become orphaned; a stopped queued launch takes them back,
as a failed one does. A create too far along to roll back finishes and is
then stopped normally, which releases them.

A stopped workspace with entries is **held**: the sidebar keeps it as a
stopped row (with its death reason, if it died) and nests its entries under
it until the last one has launched or been discarded. Restarting a held
parent keeps its children queued for its next natural stop, except those
already released, which wait only for room in their group.

## Chains

Only the top of a chain (the entry whose parent is a workspace) can be
released by a stop. The parent pointer moves down the chain as it runs:

- **At claim.** The transaction that claims an entry's launch
  (`claimQueuedLaunch`) re-points its children to the workspace id the launch
  is creating. From then on they are ordinary children of that workspace: the
  sidebar nests them under its provisioning row, and its natural stop
  releases them.
- **On failure.** `failQueuedLaunch` moves every unreleased child of that
  workspace id back under the entry, including ones queued under the
  provisioning row mid-launch. A child already released keeps its pointer. If
  that child's launch also fails, it points at a workspace that no longer
  exists: an **orphaned** entry, which the snapshot flags and the sidebar
  shows at the top level.
- **Queueing under a launching entry** (by id, through
  `yaac-mama queue --parent-workspace`) queues under the workspace it is
  becoming; the failure rule moves the child back if the launch fails.

## Settings

Every setting is resolved to a concrete value when the entry is queued, so
the sidebar and edit dialog show exactly what will run. With no parent,
defaults come from where a create's would: the project's remembered create
settings (and for `yaac-mama queue`, the caller's tool and agent mode, as
`yaac-mama create` takes them). Otherwise they come from the parent:

- A **workspace** parent supplies its first conversation's tool, mode and
  *current* model (which follows a `/model` switch), its permission mode and
  group, and its **reference branch** (`workspaces.baseBranch`, the branch it
  forked from or a later `yaac-mama set-base` named, not its own `agent/<id>`). A parent still provisioning has no
  conversation yet, so its provisioning row supplies the tool and group.
- An **entry** parent supplies its stored settings.

Choosing a different tool than the parent's takes that tool's create
defaults (`resolveCreate`) for the tool-dependent fields. A model the catalog
cannot supply is refused rather than stored empty. Queueing never updates the
project's remembered create defaults: inheriting from a parent is not a user
choice for the project.

`baseBranch` is written with the workspace row at creation (its inputs are
local reads), so a still-provisioning parent can supply it. A script like
`id=$(yaac-mama create …); yaac-mama queue --parent-workspace "$id" …` can
arrive before the row exists. The in-flight create then resolves as a parent
from its provisioning entry, which carries the requested branch. This relies
on `yaac-mama create` never claiming a spare, since a claimed spare lists
under the spare's id.

A queued launch also **skips the spare claim** (`claimSpare: false`) for the
same reason: its children already point at the id it creates under. A cold
create fetches first, so the child forks from origin's latest tip.

The **group** is fixed when the entry is queued: the parent's, unless the
request names one (by id, or by name, where an unknown name creates the
group) or `null` for the default list. Moving the parent later leaves the
entry where it was filed; deleting its group moves it to the default list.

A **title** is never inherited. If set, the launched workspace carries it
from the moment its row exists, so the title sweep never replaces it.
Without one, the title sweep (`reconcileGeneratedTitles`) titles the entry
from its prompt, as it does a draft (docs/draft-workspaces.md): one model
attempt per prompt, stored in `generatedTitle` only while the entry still has
that prompt and is not launching. Editing the prompt clears it and gets a new
attempt. The launched workspace keeps that title as its generated one, shown
until its agent gives one (docs/workspace-titles.md).

## Launching

A launch goes through `prepareStart`, the same path as the create route and
`yaac-mama create`, with `rememberDefaults` and `claimSpare` off. It shows a
normal provisioning row, headed by the entry's title (or its generated one),
and delivers the prompt like any create.

- **Claim.** A compare-and-set on `launchWorkspaceId` before anything is
  provisioned. A double-clicked Run now, or a stop racing the reconcile step,
  loses and does nothing.
- **Success** sets `launchedWorkspaceId` (a foreign key to the new workspace)
  and keeps the entry as a record of what that workspace was queued as. It
  keeps its claim, so no edit can reach it, and every store read filters it
  out. It is deleted with the workspace's row (`ON DELETE CASCADE`) or its
  project.
- **Failure** clears the claim and release, records `launchError`, and
  removes the provisioning row, so the error shows once on the queued row
  with the prompt intact.
  Stopping the launching workspace before its agent starts takes the same
  path without an error, so the entry goes back on the queue rather than
  becoming a draft.
- **Server restart mid-launch.** `resumeQueuedWorkspaces` handles it, once
  at boot, when the driver has attached. An entry claimed by nothing in this
  process is resolved. If its workspace has a row and is running, the launch
  got that far and the entry is finished, since running it again would start
  a second workspace beside the first (routines make such restarts common, a
  tick's launch taking a few seconds). Otherwise it is put back with an
  "interrupted" error, prompt and children intact, for the user to check and
  rerun. A claim made since boot (a Run now served first) is this process's
  own and is left alone. A half-made workspace that dies is a death like any
  other, and the stale reaper handles a dead one. A released entry that never
  launched, or one with no parent, is then launched where its group has
  room. After boot only scheduled starts poll, on the resync
  (docs/routines.md): stops, deaths, failed launches and group edits launch
  directly.

An entry mid-launch cannot be edited or discarded (`CONFLICT`), and the
snapshot omits it while its provisioning row stands in for it.

## Editing, discarding, running now

- **Edit** changes any stored field, including the parent, or (through the
  route) clears it to wait for room in a group with a limit. A new parent that
  is the entry itself or one of its descendants would create a cycle and is
  refused. The check walks up from the new parent, stepping from a workspace
  that some entry launched to that entry, so a launching entry cannot hide
  its ancestry.
- **Discard** deletes the entry and moves its children up to its parent (or
  its start time), so the rest of the chain runs one link sooner. With no
  parent, they wait for room in their own groups.
- **Run now** releases one entry regardless of its parent. Mid-chain, it
  leaves the chain once its launch succeeds, and its children follow it to
  the new workspace. It is refused while the entry's group is at its
  workspace limit.

## Surfaces

- **Routes** (`/workspace/queue/{create,update,discard,run}`) take and return
  JSON. They are the user's, so no permission ceiling applies.
- **Snapshot.** `queuedWorkspaces` (entries not launching, oldest first) and
  `heldWorkspaces` (stopped rows that entries wait on, in a slimmer shape
  than the stopped listing, which is too slow for a snapshot).
  `WorkspaceListEntry.permissionMode` and `effort` let the new-workspace
  pane seed a child from a live parent.
- **`yaac-mama queue`** queues under the workspace or entry named by
  `--parent-workspace` (a follow-up to the caller passes
  `$YAAC_WORKSPACE_ID`). The parent may be left out only when `--group`
  names an existing group with a workspace limit; the route
  (`/workspace/queue/create`) has the same rule. It takes every option `yaac-mama create` does and
  prints the entry id, so an agent can script a chain. Its permission mode
  defaults to the parent's and is capped at the caller's own
  (docs/permission-modes.md). `yaac-mama list` shows entries indented under
  their parents, and those with none under the group they wait in. A
  stopped parent is accepted, with a note on stderr that the
  entry starts only once the parent is restarted (`yaac-mama restart` or the
  user) and then stopped again.
- **`yaac-mama edit-queued`** changes an entry's prompt, settings or parent,
  by id or prefix within the caller's project; `--no-parent` leaves it
  waiting for room in a group with a workspace limit. The stored permission mode is
  held to the same cap, as if the edit had asked for it, so an entry above the
  caller's posture is refused until the edit names one at or below it.
  Otherwise an agent refining a prompt would run its own words under a grant
  the user gave. Changing the tool re-resolves the posture for that tool, as
  queueing does.
- **`yaac-mama run-queued`** is Run now for an agent, held to the same cap:
  an entry above the caller's posture is refused, since running it would
  start the user's grant on the agent's say. Discard is user-only.
- **Webapp.** One new-workspace pane (shown whenever no workspace is
  selected: Alt+N, the sidebar's +, a row's `…` menu, a queued row) with
  a **Start** field: `Now`, after a live workspace or queued entry stops,
  or, for a group with a workspace limit, once that group has room.
  Setting a title with the pencil beside the heading turns off auto-titling.
  **Group** follows the Start parent's until picked, and lists the groups the
  sidebar shows, those queued entries will launch into, and "+ New group"
  (a name box; the create or queue creates the group). Queued rows nest under
  their parent in the sidebar, each workspace's set (chains included) behind
  one collapsible "n queued workspaces" expander; entries with no parent
  form an "n waiting for room" set at the foot of their group's section. Sets start collapsed,
  except the one the user just queued into from the pane. The stop dialog
  lists a workspace's children so they can be edited or discarded before
  they start.
