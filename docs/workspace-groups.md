# Workspace groups

A **group** is a named sidebar section in a project. A workspace's
`workspaces.groupId` files it there; the `workspace_groups` row holds the
name, the pinned flag and an optional **workspace limit**. Deleting a group
files its members, queued entries and drafts in the default list. The
sidebar shows a group while it is pinned or has something live, held or
waiting in it.

## Workspace limits

`workspaceLimit` is the most **live** workspaces a group holds at once.
Null, the default, is unlimited. Live is what the sidebar counts:

- a workspace the runtime runs whose row has no stop;
- a create or restart still provisioning that has not failed;
- a queued entry that is launching, and a move in under way.

Stopped, held and dead workspaces do not count, and neither do queued
entries that are still waiting. A row the runtime does not have holds
nothing either: a failed create's row, which lingers until its checkout is
cleaned up, or a half-made one a server restart interrupted, which lingers
until the stale reaper records it. A stopping workspace frees its slot once
its stop is recorded, before its runtime is gone, so on k8s a group can
briefly run its limit plus the pods still terminating.

A group at its limit refuses every way a new live workspace could enter it,
with a `CONFLICT` naming the group and its limit:

- a create into it: the create route, `yaac-mama create --group`, the
  new-workspace pane, and a claim of a prewarmed spare (all through
  `prepareStart`);
- a restart of a stopped member: the webapp, the CLI and `yaac-mama restart`
  (`prepareRestart`). A running member already holds its slot;
- a move of a live workspace into it: `/group/move`, `yaac-mama group move`
  and sidebar drag-and-drop (`moveWorkspaceToGroup`). A stopped workspace
  moves in freely;
- "Run now" on a queued entry filed in it, from the webapp or
  `yaac-mama run-queued`.

Lowering a limit below the live count stops nothing; it only blocks new
entries until the count drops. The limit is set in the group's `…` menu
(Workspace limit…), `yaac group set-limit` or `yaac-mama group set-limit`,
all through `/group/set-limit`. The sidebar header shows `(live/limit)`, or
`(live)` with no limit, and the stopped count beside it.

A limit schedules agents; it does not contain them. Any workspace in the
project can raise or clear one with `yaac-mama group set-limit`, its own
group's included, or create outside the group, so nothing should rely on a
limit as a policy.

### Why the check is race-free

The server is one process. A check reads the rows and the runtime
(`readGroupRoom`), then in one synchronous step adds what this process has
in flight and takes the slot: a create or restart registers its
provisioning row, while a queued launch or a move holds a reservation until
its row is written. Two concurrent entries cannot both see the last free
slot. Everything registers in memory before it runs, and a provision that
succeeds after the read is counted from the registry's record of what went
live since (`wentLiveSince`), so a read that lags does not hide a taken
slot.

## Waiting for room

A queued entry with no parent waits for room in its group
(docs/queued-workspaces.md). It may be queued only into an existing group
with a limit, since an unlimited group never makes anything wait; anything
else is refused with a pointer to `create`, or to a parent. A chained entry
released into a full group by its parent's stop waits the same way. It keeps
its release and its parent pointer, but its parent's later restart and stop
no longer matter to it.

`startWaitingWorkspaces` launches what waits, oldest first, while each
group has room; a group with no limit (or none) always has room. It runs
wherever a slot may free:

- a natural stop, and a stopped create or restart;
- every pass of the stale reaper's step, which runs whenever the runtime
  changes: a runtime that went away frees its slot at once, before a death
  is recorded;
- a create or restart that fails, and a queued launch that fails;
- a move out of the group;
- a raised or cleared limit, or a deleted group;
- a queue, edit or discard;
- once at boot (`resumeQueuedWorkspaces`), for slots freed while no server
  ran.

Each launch takes its slot before it claims the entry, so a burst of stops
cannot launch past the limit. A failed launch waits for the user, as any
does. So does an entry with no parent whose launch the user stops, which
would otherwise relaunch at once.
