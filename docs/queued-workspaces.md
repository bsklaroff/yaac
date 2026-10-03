# Queued workspaces

A **queued workspace** (an *entry*) is a workspace create request saved for
later: a prompt plus the full create settings (tool, model, agent mode,
permission mode, reference branch, and optionally a title and a sidebar
group), attached to a **parent**. It runs when the parent stops *naturally*:
a user stop from the webapp or `yaac workspace stop`, or an agent's
`yaac-mama stop`. It does not run when the parent dies (OOM, crash, eviction,
the agent exiting); it waits until the user runs or discards it.

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
children launch together. An agent exiting (`/exit`) counts as a death, since
the reaper records `agent-exited` and can't tell it from a crash, so an agent
that is done should call `yaac-mama stop`.

A stopped workspace with entries is **held**: the sidebar keeps it as a
stopped row (with its death reason, if it died) and nests its entries under
it until the last one has launched or been discarded. Restarting a held
parent keeps its children queued for its next natural stop.

## Chains

Only the top of a chain (the entry whose parent is a workspace) can be
released by a stop. The parent pointer moves down the chain as it runs:

- **At claim.** The transaction that claims an entry's launch
  (`claimQueuedLaunch`) re-points its children to the workspace id the launch
  is creating. From then on they are ordinary children of that workspace: the
  sidebar nests them under its provisioning row, and its natural stop
  releases them, even if that stop comes before the launch finishes.
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
the sidebar and edit dialog show exactly what will run. Defaults come from
the parent:

- A **workspace** parent supplies its first conversation's tool, mode and
  *current* model (which follows a `/model` switch), its permission mode and
  group, and its **reference branch** (`workspaces.baseBranch`, the branch it
  forked from, not its own `agent/<id>`). A parent still provisioning has no
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
attempt. The launched workspace uses that title.

## Launching

A launch goes through `startWorkspace`, the same path as the create route and
`yaac-mama create`, with `rememberDefaults` and `claimSpare` off. It shows a
normal provisioning row and delivers the prompt like any create.

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
  Stopping the launching workspace before its agent starts is a failure
  too, so the entry goes back on the queue rather than becoming a draft.
- **Server restart mid-launch.** The `queued-workspaces` reconcile step
  handles it. On its first successful pass, an entry claimed by nothing in
  this process is put back with an "interrupted" error, prompt and children
  intact, for the user to check and rerun. Later passes leave claims alone,
  since any claim then is this process's own. The step does not guess whether the launch finished, because the
  workspace exists long before a create is done; any half-made workspace is
  the stale reaper's job. A released entry that never launched is launched.
  The step has no triggers: `stopWorkspace` launches directly, and the resync
  retries a release whose launch threw.

An entry mid-launch cannot be edited or discarded (`CONFLICT`), and the
snapshot omits it while its provisioning row stands in for it.

## Editing, discarding, running now

- **Edit** changes any stored field, including the parent. A new parent that
  is the entry itself or one of its descendants would create a cycle and is
  refused. The check walks up from the new parent, stepping from a workspace
  that some entry launched to that entry, so a launching entry cannot hide
  its ancestry.
- **Discard** deletes the entry and moves its children up to its parent, so
  the rest of the chain runs one link sooner.
- **Run now** releases one entry regardless of its parent. Mid-chain, it
  leaves the chain once its launch succeeds, and its children follow it to
  the new workspace.

## Surfaces

- **Routes** (`/workspace/queue/{create,update,discard,run}`) take and return
  JSON. They are the user's, so no permission ceiling applies.
- **Snapshot.** `queuedWorkspaces` (entries not launching, oldest first) and
  `heldWorkspaces` (stopped rows that entries wait on, in a slimmer shape
  than the stopped listing, which is too slow for a snapshot).
  `WorkspaceListEntry.permissionMode` lets the create dialog seed a child
  from a live parent.
- **`yaac-mama queue`** queues under the workspace or entry named by the
  required `--parent-workspace` (a follow-up to the caller passes
  `$YAAC_WORKSPACE_ID`). It takes every option `yaac-mama create` does and
  prints the entry id, so an agent can script a chain. Its permission mode
  defaults to the parent's and is capped at the caller's own
  (docs/permission-modes.md). `yaac-mama list` shows entries indented under
  their parents.
- **`yaac-mama edit-queued`** changes an entry's prompt, settings or parent,
  by id or prefix within the caller's project. The stored permission mode is
  held to the same cap, as if the edit had asked for it, so an entry above the
  caller's posture is refused until the edit names one at or below it.
  Otherwise an agent refining a prompt would run its own words under a grant
  the user gave. Changing the tool re-resolves the posture for that tool, as
  queueing does. Discard and Run now are user-only.
- **Webapp.** One create dialog (Alt+N, a row's `…` menu, a queued row) with
  a **Start** field: `Now`, or after a live workspace or queued entry stops.
  Setting a title with the pencil beside the heading turns off auto-titling.
  **Group** follows the Start parent's until picked, and lists the groups the
  sidebar shows, those queued entries will launch into, and "+ New group"
  (a name box; the create or queue creates the group). Queued rows nest under
  their parent in the sidebar, each workspace's set (chains included) behind
  one collapsible "n queued workspaces" expander. Sets start collapsed,
  except the one the user just queued into from the dialog. The stop dialog
  lists a workspace's children so they can be edited or discarded before
  they start.
