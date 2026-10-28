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
in the steps `workspace-timeouts`, `routines` and `scheduled-workspaces`, in
that order, none with a trigger of its own. The rest of the queue is
event-driven (docs/queued-workspaces.md); only a start time needs a clock. So a start, a stop or a tick
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

`queued_workspaces.startAt` is the third kind of parent: at most one of
`parentWorkspaceId`, `parentQueuedId` and `startAt` is set, and an entry with
none waits for room in its group (docs/workspace-groups.md). A scheduled
entry never counts as waiting for room before its time, and is always the
top of a chain; entries queued under it follow the ordinary chain rules.
There is no "after X stops, but not before T": a chain whose top is
scheduled covers it. With no parent to inherit from, its settings come from
the project's create defaults.

The `scheduled-workspaces` step (`startScheduledWorkspaces`) releases every
due entry and launches it where its group has room, as any released entry.
One whose group is full waits for room from then on, and its window counts
on from its start time, so a long wait can use it up.

- **A failure waits for the user.** An entry with a `launchError` is never
  released by its time, or a broken one would retry every minute. Run now,
  or an edit giving it a new start time, clears the error. A stopped launch
  records an error too ("stopped before it started"), since its time has
  passed and it would otherwise launch again at once.
- **A missed window is not launched.** An entry's timeout counts from its
  start time, so one whose whole window passed while the server was down
  fails with an error rather than running for no time.
- **A discard never launches what came after.** Discarding an entry moves
  its children up to its parent, or its start time. A start time already
  past would launch them on the next pass although their parent never ran,
  so they take it with an error and wait for the user.

## Timeouts

`workspaces.deadline` is when the server stops a workspace; null means
never, and `timeoutMinutes` beside it is how long the timeout that set it
ran for. It counts from when the workspace was meant to start: an entry's
`startAt` if it has one, otherwise when it is created. Run now on a
scheduled entry counts from now, but a routine's run always counts from its
tick, so even one run late stops at the next tick. `prepareStart` takes the
absolute deadline, so each caller picks its anchor; queued entries store a
relative `timeoutMinutes`.

The `workspace-timeouts` step stops every running workspace past its
deadline with `stopWorkspace`, as the system:

- **A timeout is a natural stop.** The user asked for it, so it is not a
  death: it releases the workspace's queued children, harvests credentials
  and keeps the checkout, as a user stop does. "Run A for an hour, then B"
  works through the queue.
- **A create is never interrupted.** Stopping one still provisioning would
  roll it back into a draft or onto the queue, where a scheduled entry would
  launch again; it finishes and is stopped on the next resync.
- **Timed out is derived.** A natural stop (no death reason) whose
  `stoppedAt` is at or after its deadline timed out; the listings say so. It
  is not a `WorkspaceDeathReason`, and one that died after its deadline
  died.
- **A restart replaces the deadline.** Without a timeout of its own it
  clears it: a workspace the user brings back is theirs to stop, and a past
  deadline would stop it again at once.
- **Agents set timeouts as the user does, short of a running one's.**
  `/workspace/timeout` sets a running workspace's deadline from now or
  clears it, and no `yaac-mama` verb reaches it. Everywhere else an agent
  may give any length or none: `edit-queued --timeout <d|none>`,
  `routine edit --timeout <d|next>`, and `yaac-mama restart`, which gives a
  workspace that had a timeout the same length again unless `--timeout`
  names another or `none`. Agents read deadlines, their own included, from
  `yaac-mama list`.

## Routines

A routine (`routines`) stores a name, a 5-field cron (or `@daily`-style
nickname, via croner), the IANA zone it is read in, the settings each run
launches with (resolved when saved, as a queued entry's are), an optional
`timeoutMinutes`, `paused`, and `nextRunAt`.

**Firing.** The `routines` step takes each unpaused routine whose
`nextRunAt` has passed, skipping one in a removed share. In one transaction
(`insertRoutineRun`) it moves `nextRunAt` to the next tick by
compare-and-set and inserts a queued entry with `startAt` at that tick and
`routineId`, which the next step launches in the same pass. So a tick fires
exactly once: a racing pass or pause wins or loses whole, and a failure
leaves the tick due. Ticks missed while the server was down collapse into
the latest of them; there is no backlog. Only firing, pause and resume
write `nextRunAt` and `paused`; an edit replaces the settings and writes
`nextRunAt` only when the cron or zone changed, so an edit that read the
routine before a tick fired never re-arms it.

**The auto-timeout is the gap after this tick.** A run with no routine
timeout stops at the routine's next tick after its start, exactly (its
entry shows the gap in minutes), so a weekdays-at-9 routine gives Friday's
run until Monday and an irregular cron is right every time. The old run is
stopped in the pass that starts the next. An explicit timeout longer
than the gap lets runs overlap, which is what it asks for.

**Failures show once.** A tick's run replaces the routine's runs that never
launched, so a broken routine shows one failed run (the routine's
`lastError`) rather than one per tick. Anything queued after a replaced run
moves onto the new one, and the new run takes the oldest replaced one's
place in line, so a run waiting for room in a busy group is not sent to the
back each tick.

**Groups.** A routine's group is an ordinary setting. Created without one,
its runs go in a group named after it (made if need be); `null` is the
default list. Renaming the routine does not move it.

**History.** A run launched with the next tick as its deadline is marked so
(`workspaces.deadlineIsNextRun`, cleared by any later deadline write), and a
stop there reads "ended at next run" everywhere a stop is listed, since the
next run began; one stopped by the routine's own timeout reads "timed out".
The mark is the run's own, so giving the routine a timeout later does not
relabel its past runs.

**Run now** inserts a run at the current time without moving `nextRunAt`;
with no timeout of its own it stops at the next scheduled tick, however
close to it it starts. Refused because its group is full, it leaves no run
behind. **Pause** clears `nextRunAt`; **resume** re-reads it from now,
without catching up. An edit re-reads it only when the cron or zone changes.
**Delete** discards unlaunched runs; running ones keep their deadlines.

A run's entry stays as a record once it launches (docs/queued-workspaces.md
"Launching"), so a routine's entries are its run history, and
`WorkspaceListEntry.routineId` comes from the same join. Deleting a run's
workspace deletes its record too, so the history holds only runs whose
workspaces still exist: with a project's stopped-workspace retention set,
it reaches back only that many days.

**Agents make routines on the queue's terms.** `yaac-mama routine
create|edit|pause|resume|run|delete` reach the same functions as the
routes, with the calling workspace's permission mode as the ceiling
(`QueueSource`), as for a queue write: a routine an agent makes or edits
launches at most as permissively as that agent, one already above it is
refused until the edit lowers it, and resume and run (which set runs off)
are refused for it. Pause only restrains, and delete loses a prompt, a
schedule and the run history the routine lists, but no running work and
no run's workspace, so neither is held to the ceiling. A routine
keeps starting unattended agents after whatever made it is gone, which is
why its ceiling is fixed when it is saved rather than read at each tick.

A run that asks for permission waits until its timeout stops it; the
routine form says so beside the permission mode.

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
  `--timeout` (`none` clears one on `edit-queued` and `restart`); `queue`
  and `edit-queued` take `--start-at`/`--start-in`; `list` shows deadlines
  (STOPS), scheduled entries under their time, the project's routines, and
  `timed out`. `routine create|edit|pause|resume|run|delete` manage
  routines (above).
- **Webapp.** The new-workspace pane's Start offers a time, a delay, or a
  schedule (a routine form with schedule presets that compile to cron, a
  zone, and a live preview of the next runs), and a Timeout row. The sidebar
  has Scheduled and Routines sections, describing each routine's cron in
  words (cronstrue); a routine opens in its own pane with its cron and its
  runs; a workspace with a deadline shows a chip to extend or clear it,
  and a routine's run links back to its routine.
