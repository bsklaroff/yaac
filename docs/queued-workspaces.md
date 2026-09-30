# Queued workspaces

A **queued workspace** (an *entry*) is a workspace create request saved for
later: a prompt plus the full create settings — tool, model, UI mode,
permission mode, reference branch, and optionally a title and a sidebar
group — attached to a **parent**. It runs when
the parent stops *naturally*: a user stop from the webapp or `yaac workspace
stop`, or an agent's `yaac-mama stop`. It does not run when the parent dies
(OOM, crash, eviction, the agent exiting); it waits under the parent until
the user runs or discards it.

The parent is a workspace or **another entry**, so requests chain to any
depth. An entry under an entry waits for its parent to launch *and then*
stop naturally; each link is a full workspace run. Entries are not
workspaces — they have no `workspaces` row, checkout or runtime until they
launch — and the UI never calls them sessions (docs/naming.md). In code,
"queue" already names the proxy's `yaac-mama` request queue, so this
feature's modules and table are `queued-workspace*` / `queued_workspaces`.

## When an entry runs

The release happens in `stopWorkspace` and nowhere else, because that
function is exactly the set of natural stops: every user- or agent-requested
stop reaches it, and nothing else that records a stop does — the stale
reaper's teardowns, a restart's teardown, a failed resume and project
removal all go around it. Stop *records* cannot tell these apart (a
`workspace-stopped` event with no cause covers restart teardown and failed
resumes too), so the call site is the trigger.

`stopWorkspace` releases once the stop is recorded, not once the runtime is
gone: a child has its own checkout and runtime. All of a parent's direct
children release together and launch concurrently. Exiting the agent
(`/exit`) is a death — the reaper records `agent-exited`, which it cannot
tell from a crash — so an agent that is done calls `yaac-mama stop`.

A stopped workspace with at least one entry is **held**: the sidebar keeps it
as a stopped row, with its death reason if it died, and nests its entries
under it until the last one has launched or been discarded. Restarting a held
parent brings it back with its children still queued for its *next* natural
stop.

## Chains

Only the top of a chain — the entry whose parent is a workspace — can be
released by a stop; an entry never stops, so nothing below can run early.
The parent pointer moves down the chain as it runs:

- **At claim.** The transaction that claims an entry's launch
  (`claimQueuedLaunch`) re-points its children from the entry to the workspace
  id the launch is creating. From then on they are ordinary children of a
  workspace: the sidebar nests them under its provisioning row, and its natural
  stop releases them — even one that comes before the launch has finished.
- **On failure.** `failQueuedLaunch` moves every *unreleased* child of that
  workspace id back under the entry, including ones queued under the
  provisioning row mid-launch. A child the workspace's own stop already
  released keeps its pointer: a release is never taken back. If that child's
  launch then fails too, it points at a workspace whose failed create deleted
  its row — an **orphaned** entry, which the snapshot flags and the sidebar
  shows at the top level.
- **Queueing under a launching entry** (possible by id through
  `yaac-mama queue --parent-workspace`) queues under the workspace it is becoming, and
  the failure rule takes the child back if the launch fails.

## Settings

Every setting is resolved to a concrete value when the entry is queued, so
what the sidebar and the edit dialog show is exactly what will run. They
default from the parent:

- A **workspace** parent supplies its first conversation's tool, mode and
  *current* model (which follows a `/model` switch), its row's permission
  mode and group, and its **reference branch** (`workspaces.baseBranch`, the
  branch it forked from — not its own `agent/<id>` branch). A parent still
  provisioning has no conversation yet, so its provisioning row names the
  tool and group.
- An **entry** parent supplies its stored settings.

A tool other than the parent's takes that tool's create defaults
(`resolveCreate`) for the tool-dependent fields instead. A model the catalog
cannot supply is refused rather than stored empty.

`baseBranch` is recorded with the workspace row at creation — every input
(`options.branch ?? getDefaultBranch`) is a local
read — so a parent that is still provisioning supplies its branch. The
`base-branch-resolved` event survives only for a claimed spare's re-branch.
`id=$(yaac-mama create …); yaac-mama queue --parent-workspace "$id" …` can arrive
before even the row: a create in flight under its own id (never a spare
claim, whose workspace lists under the spare's id — which is why `yaac-mama
create` never claims one) resolves as a parent from its provisioning entry,
which carries the branch it asked for.

A queued launch **skips the spare claim** (`claimSpare: false`). Its claim
has already pointed the entry's children at the workspace id it creates
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
**title** is the user's own and never inherited; the workspace it launches
carries it from the moment its row exists, so the title sweep never
replaces it. Without one, the title sweep (`reconcileGeneratedTitles`)
titles the entry from its prompt as it does a draft (docs/draft-workspaces.md):
one model attempt per prompt, written to the entry's `generatedTitle` only
while it still holds that prompt and is not mid-launch. An edit that changes
the prompt clears it, and the new prompt gets its own attempt. The sidebar
shows it, and the workspace the entry launches carries it as its title.

## Launching

A launch goes through `startWorkspace`, the one create path (the create route
and `yaac-mama create` use it too), with `rememberDefaults` and `claimSpare`
off. It shows a normal provisioning row and delivers the prompt as any
create does.

- **Claim.** A compare-and-set on `launchWorkspaceId` before anything is
  provisioned under that id. A Run-now double-click, or a stop racing the
  reconcile step, loses and does nothing.
- **Success** sets `launchedWorkspaceId`, a foreign key to the workspace it
  created, and keeps the entry as the record of what that workspace was queued
  as. It keeps its claim too, so no edit reaches it; the writes that reach
  it through another entry (splicing or re-pointing that entry's children,
  deleting a group) and every store read filter it out, so above the store
  it is gone. It is deleted with that
  workspace's row (`ON DELETE CASCADE`) or its project.
- **Failure** clears the claim and the release, records `launchError`, and
  removes the provisioning row, so the error shows once, on the queued row,
  with the prompt still there.
- **Server restart mid-launch.** The `queued-workspaces` reconcile step is the
  crash backstop. An entry claimed by nothing in this process is put back
  with an "interrupted" error, prompt and children intact, for the user to
  check and run again. It is not guessed at: the workspace exists long before
  a create is done (agent respawned, prompt typed), so a live one says
  nothing about whether the launch finished, and a half-made workspace it
  leaves is the stale reaper's. A release that never launched is launched.
  The step has no triggers: `stopWorkspace` launches directly, and the resync
  (the first pass after start is one) is enough.

An entry whose launch is in flight cannot be edited or discarded
(`CONFLICT`), and is absent from the snapshot while its provisioning row
stands in for it.

## Editing, discarding, running now

- **Edit** changes any stored field, including the parent. A parent that is
  the entry or one of its descendants would make a cycle that never runs, and
  is refused. The check walks up from the new parent and steps from a workspace
  that is some entry's launch to that entry: a launching entry otherwise hides
  its ancestry, and a failed launch would close the cycle the walk missed.
- **Discard** deletes the entry and splices its children up to its own
  parent, so the rest of the chain runs one link sooner.
- **Run now** releases one entry whatever its parent is doing. Mid-chain, it
  leaves the chain once its launch succeeds; its children follow it to the
  new workspace.

## Surfaces

- **Routes** (`/workspace/queue/{create,update,discard,run}`) take and answer
  JSON — nothing about queueing is slow, and a Run now's progress is its
  provisioning row. They are the user's, so no permission ceiling applies.
- **Snapshot.** `queuedWorkspaces` (entries not launching, oldest first) and
  `heldWorkspaces` (stopped rows entries wait on — a slimmer shape than the
  stopped listing, which stats transcripts and is too slow for a snapshot).
  `WorkspaceListEntry.permissionMode` lets the create dialog seed a child from
  a live parent.
- **`yaac-mama queue`** queues under the workspace or entry
  `--parent-workspace` names — required, so a follow-up to the caller names
  `$YAAC_WORKSPACE_ID` — takes every option `yaac-mama create` does, and
  prints the entry id so an agent can build a chain in a script. Its posture defaults to the parent's and is held to the
  caller's own as a ceiling (docs/permission-modes.md). `yaac-mama list`
  shows entries indented under their parents.
- **`yaac-mama edit-queued`** changes an entry's prompt, any of those
  settings, or its parent, by id or prefix within the caller's project. It
  holds the stored posture to the same ceiling, as if it were asked for: an
  agent refining a prompt would otherwise put its own words behind a grant
  the user gave, so an entry above the caller's posture is refused until the
  edit names one at or below it. A new tool is the exception — its posture
  is re-resolved for that tool, as queueing does, so it lands at or below
  the caller's. Discard and Run now stay the user's.
- **Webapp.** One create dialog (Alt+N, a row's `…` menu, a queued row) with
  a **Start** field: `Now`, or after a live workspace or queued entry stops.
  A title set with the pencil beside its heading turns off auto-titling for
  what it creates, and its **Group** follows the Start parent's until it is
  picked. The Group lists the groups the sidebar shows (pinned, or holding a
  live, starting or held workspace), those a queued entry will launch into,
  and "+ New group", which swaps the dropdown for a name box; the create or
  queue brings that group into being. Queued rows nest under their parent
  in the sidebar, each workspace's whole set (chains included) behind one
  collapsible "n queued workspaces" expander. Sets start collapsed; the one
  exception is the set the user just queued or moved an entry into from the
  dialog, which opens so the result shows. The stop dialog lists a workspace's children so
  they can be edited or discarded before they start.
