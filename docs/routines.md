# Scheduled workspaces, timeouts and routines

Three features start or stop a workspace on a clock rather than on a user
action:

- **Scheduled starts.** A queued workspace (docs/queued-workspaces.md) can
  start at a time instead of after a parent stops.
- **Timeouts.** The server stops a workspace a set time after it starts.
- **Routines.** A cron schedule that starts a fresh workspace on every tick.
  A routine with no timeout of its own stops each run at the next tick, so
  runs never overlap.

None of them adds a launch path. A scheduled start is a queued entry whose
"parent" is a time; a routine's tick inserts such an entry; a timeout is a
column on `workspaces` and a reconcile step that calls the ordinary
`stopWorkspace`.

## The clock

All three run on the reconciler's 60-second resync (docs/event-driven-reconcile.md),
in the steps `workspace-timeouts`, `routines` and `queued-workspaces`, in
that order, none with a trigger of its own. So a start, a stop or a tick
lands up to about a minute after its time, and that is the resolution the
features promise: durations are whole minutes, one at least, and the UIs
word times as approximate ("starts at about 09:00"). The order means a
routine's previous run is stopped in the same pass that launches the next.

## Times and zones

A wall-clock time is read in the user's stored zone (`getTimeZone`): the one
they pinned in settings, else the one the webapp, the auth daemon or the CLI
last reported from their device. A user with none stored (only a raw API
caller) falls back to UTC. It is never the zone of the process that typed
the time, nor a workspace's `TZ`, which is only a copy taken at launch. So
the server reads every wall-clock time itself (`resolveStartAt` in
`@yaac/shared/schedule`), from text: an ISO time with an offset is absolute,
one without (what a `datetime-local` input yields) is read in the zone, and a
bare `HH:MM` is its next occurrence. A delay (`startIn`) is counted on the
server's clock, so a client's clock does not matter. Times are shown in the
same zone, and replies that take one name it.

## Scheduled starts

`queued_workspaces.startAt` is the third kind of parent: exactly one of
`parentWorkspaceId`, `parentQueuedId` and `startAt` is set. A scheduled entry
is always the top of a chain; entries queued under it follow the ordinary
chain rules. There is no "after X stops, but not before T": a chain whose
top is scheduled covers it. With no parent to inherit from, its settings
come from the project's create defaults.

The `queued-workspaces` step releases every due entry
(`releaseDueQueuedWorkspaces`) and launches it as any released entry.

- **A failure waits for the user.** An entry with a `launchError` is never
  released by its time, or a broken one would retry every minute. Run now,
  or an edit giving it a new start time, clears the error. A stopped launch
  records an error too ("stopped before it started"), since its time has
  passed and it would otherwise launch again at once.
- **A missed window is not launched.** An entry's timeout counts from its
  start time, so one whose whole window passed while the server was down
  fails with an error rather than running for no time.

## Timeouts

`workspaces.deadline` is when the server stops a workspace; null means
never. It counts from when the workspace was meant to start: an entry's
`startAt` if it has one (so a routine's run stops exactly at the next tick),
otherwise when it is created. Run now counts from now. `prepareStart` takes
the absolute deadline, so each caller picks its anchor; queued entries store
a relative `timeoutMinutes`.

The `workspace-timeouts` step stops every running workspace past its
deadline with `stopWorkspace`, as the system:

- **A timeout is a natural stop.** The user asked for it, so it is not a
  death: it releases the workspace's queued children, harvests credentials
  and keeps the checkout, as a user stop does. "Run A for an hour, then B"
  works through the queue.
- **A create is never interrupted.** Stopping one still provisioning would
  roll it back into a draft or onto the queue, where a scheduled entry would
  launch again; it finishes and is stopped on the next resync.
- **Timed out is derived.** A stopped workspace whose `stoppedAt` is at or
  after its deadline timed out; the listings say so, and it is not a
  `WorkspaceDeathReason`.
- **A restart replaces the deadline.** Without a timeout of its own it
  clears it: a workspace the user brings back is theirs to stop, and a past
  deadline would stop it again at once.
- **Only the user changes a running one.** `/workspace/timeout` sets a
  deadline from now or clears it; no `yaac-mama` verb reaches it, so an agent
  cannot extend its own life. Agents read deadlines, their own included,
  from `yaac-mama list`.

## Routines

A routine (`routines`) stores a name, a 5-field cron (or `@daily`-style
nickname, via croner), the IANA zone it is read in, the settings each run
launches with (resolved when saved, as a queued entry's are), an optional
`timeoutMinutes`, `paused`, and `nextRunAt`.

**Firing.** The `routines` step takes each unpaused routine whose
`nextRunAt` has passed, skipping one in a removed share. It moves
`nextRunAt` to the next tick first, by compare-and-set, so a tick fires once
even across racing passes or a failed insert. Ticks missed while the server
was down collapse into the latest of them; there is no backlog. Then it
inserts a queued entry with `startAt` at that tick and `routineId`, which the
next step launches in the same pass.

**The auto-timeout is the gap after this tick.** A run with no routine
timeout gets the minutes from its tick to the following one, so a
weekdays-at-9 routine gives Friday's run until Monday and an irregular cron
is right every time. With the timeout counting from the start time, the old
run is stopped in the pass that starts the next. An explicit timeout longer
than the gap lets runs overlap, which is what it asks for.

**Failures show once.** Before a tick inserts its run, the routine's runs
that never launched are discarded, so a broken routine shows one failed run
(the routine's `lastError`) rather than one per tick.

**Groups.** A routine's group is an ordinary setting. Created without one,
its runs go in a group named after it (made if need be); `null` is the
default list. Renaming the routine does not move it.

**Run now** inserts a run at the current time without moving `nextRunAt`;
with no timeout of its own it stops at the next scheduled tick, rounded down
to the minute. **Pause** clears `nextRunAt`; **resume** re-reads it from now,
without catching up. An edit re-reads it only when the cron or zone changes.
**Delete** discards unlaunched runs; running ones keep their deadlines.

A run's entry stays as a record once it launches (docs/queued-workspaces.md
"Launching"), so a routine's entries are its run history, and
`WorkspaceListEntry.routineId` comes from the same join.

**Only the user makes routines.** A routine keeps starting unattended agents
after whatever asked for it is gone, a standing grant beyond queueing one
follow-up, so `yaac-mama` has no verb for it. A run that asks for
permission waits until its timeout stops it; the routine form says so
beside the permission mode.

## Surfaces

- **Routes.** `/workspace/create` and `/workspace/restart` take `timeout`
  (minutes); `/workspace/queue/{create,update}` take `startAt` (text),
  `startIn` (minutes) and `timeout`, a queue naming exactly one of `parent`,
  `startAt` and `startIn`; `/workspace/timeout`; `/workspace/queue/list`;
  `/routine/{list,runs,create,update,pause,resume,run,delete}`. The routine
  writes are the owner's; `runs` is any reader's.
- **Snapshot.** `routines` (with each one's next three ticks, so clients
  need no cron code to list them), `QueuedWorkspaceEntry.startAt` and
  `timeoutMinutes`, `WorkspaceListEntry.deadline` and `routineId`, and
  `timedOut` on stopped and held rows.
- **CLI.** `yaac workspace create --timeout/--start-at/--start-in`,
  `restart --timeout`, `timeout <id> <duration|none>`, scheduled entries in
  `workspace list` and discarded by `workspace delete`, and `yaac routine
  create|list|edit|pause|resume|run|delete` (docs/cli.md).
- **yaac-mama.** `create`, `queue`, `edit-queued` and `restart` take
  `--timeout`; `queue` and `edit-queued` take `--start-at`/`--start-in`;
  `list` shows deadlines (STOPS), scheduled entries under their time, and
  `timed out`.
- **Webapp.** The new-workspace pane's Start offers a time, a delay, or a
  schedule (a routine form with schedule presets that compile to cron, a
  zone, and a live preview of the next runs), and a Timeout row. The sidebar
  has Scheduled and Routines sections; a routine opens in its own pane with
  its runs; a workspace with a deadline shows a chip to extend or clear it,
  and a routine's run links back to its routine.
