/**
 * Queued workspaces (docs/queued-workspaces.md): create requests that run
 * when their parent (a workspace or another entry) stops naturally, so they
 * chain to any depth, that start at a time (docs/routines.md), or that wait
 * with no parent for room in a group with a workspace limit
 * (docs/workspace-groups.md).
 *
 * Settings are resolved when queued, so the sidebar shows exactly what will
 * launch. Launches go through `prepareStart` without claiming a spare,
 * since children already point at the new id. Only `stopWorkspace` releases
 * children; a workspace that died holds them until the user runs or discards
 * them. A released entry, or one with no parent, launches once its group
 * has room (`startWaitingWorkspaces`).
 */
import crypto from 'node:crypto'
import { resolveCreate } from './create'
import { resolveGroup } from './groups'
import { groupFull, readGroupRoom, refuseFullGroup, reserveGroupSlot } from './group-limits'
import {
  inFlightCreate,
  listProvisioning,
  onProvisionFailed,
  ProvisionStoppedError,
  refuseDeleting,
  removeProvisioning,
} from './provisioning'
import { resolveWorkspace } from './resolve'
import { workspaceDriver } from '#drivers/driver'
import { prepareStart } from './start'
import { toStoppedEntries } from './stopped-list'
import { modelDisplayName, modelEfforts } from '#domain/auth'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { getDefaultBranch } from '#domain/git'
import {
  claimQueuedLaunch,
  deleteQueuedWorkspace,
  failQueuedLaunch,
  findWorkspaceRow,
  finishQueuedLaunch,
  firstAgentSession,
  getProjectRow,
  getProjectWorkspaceRows,
  getQueuedWorkspaceRow,
  getRoutineRow,
  getTimeZone,
  insertQueuedWorkspace,
  listQueuedWorkspaceRows,
  listWorkspaceRows,
  markDeadlineIsNextRun,
  releaseDueQueuedWorkspaces,
  releaseQueuedChildren,
  releaseQueuedWorkspace,
  updateQueuedWorkspace as updateQueuedWorkspaceRow,
  type QueuedParent,
  type QueuedWorkspaceRow,
  type QueuedWorkspaceSettings,
} from '#db'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { repoDir } from '@yaac/shared/project-paths'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import { nextCronRuns, resolveStartAt } from '@yaac/shared/schedule'
import {
  agentPermissionMode,
  MAX_PROMPT_LENGTH,
  PROMPT_TOO_LONG,
  launchableModel,
  toolSupportsPermissionMode,
  type AgentMode,
  type AgentTool,
  type HeldWorkspaceEntry,
  type PermissionMode,
  type QueuedWorkspaceEntry,
} from '@yaac/shared/types'

/**
 * When a scheduled entry starts: a `--start-at` text, read in the project
 * owner's zone (`resolveStartAt`), or minutes from the server's now.
 */
export type QueueStart = { at: string } | { inMinutes: number }

/** What a queue write asks for. Every field but the prompt is optional and
 *  resolved from the parent, then from the project's create defaults. */
export interface QueueRequest {
  /** A workspace id, or a queued entry's id — or a unique prefix of either.
   *  Absent or null with no `start`, the entry waits for room in `group`,
   *  which must name a group with a workspace limit. */
  parent?: string | null
  /** Start at a time instead of after a parent; refused with one. */
  start?: QueueStart
  /** Minutes until the launched workspace is stopped, counted from its start
   *  time if it has one; null (on an edit) clears it. */
  timeout?: number | null
  prompt: string
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  /** Refused if the model lacks it; unnamed is the project's remembered
   *  effort where the model has it, else the model's default. */
  effort?: string
  branch?: string
  /** The launched workspace's title; blank leaves it to be auto-titled. */
  title?: string
  /** A group id or name — a name matching none is created; null is the
   *  default list, absent the parent's. */
  group?: string | null
}

/**
 * Who is queueing. The user is unconstrained; an agent (`yaac-mama queue`)
 * may start nothing more permissive than itself, so it carries its own
 * recorded posture as the ceiling.
 */
export type QueueSource = 'user' | { ceiling: PermissionMode }

/** A resolved parent and the settings it supplies as defaults (absent when
 *  not yet known, or with no parent). */
interface ParentInfo {
  pointer: QueuedParent
  tool?: AgentTool
  mode?: AgentMode
  model?: string
  permissionMode?: PermissionMode
  branch?: string
  groupId?: string
}

/** Entries this process is launching. Any other claimed entry was
 *  interrupted by a server restart. */
const launching = new Set<string>()

// A failed create or restart frees a slot that no stop reports.
onProvisionFailed((projectId) => { void startWaitingWorkspaces(projectId) })

/** Queue a create request under a workspace or another entry. */
export async function queueWorkspace(
  principal: Actor,
  projectId: string,
  request: QueueRequest,
  source: QueueSource,
  generatedTitle?: string,
): Promise<QueuedWorkspaceEntry> {
  await authorizeProject(principal, projectId)
  checkPrompt(request.prompt)
  if (request.parent != null && request.start !== undefined) {
    throw new ServerError('VALIDATION', 'a queued workspace waits on a parent or starts at a time, not both')
  }
  const parent = request.start !== undefined
    ? { pointer: { startAt: await resolveStart(projectId, request.start) } }
    : request.parent == null
      ? await roomToWaitIn(projectId, request.group)
      : await resolveParent(projectId, request.parent)
  const settings = await resolveSettings(projectId, parent, {
    ...request,
    ...(parent.pointer === null ? { group: parent.groupId ?? null } : {}),
  }, source)
  refuseDeletedParent(parent.pointer)
  const row = await insertQueuedWorkspace(projectId, parent.pointer, settings,
    generatedTitle !== undefined ? { generatedTitle } : {})
  const [entry] = await toEntries([row])
  await startWaitingWorkspaces(projectId)
  return entry
}

/**
 * The instant a start names. A wall-clock text is read in the project
 * owner's zone (queue writes are the owner's), else UTC.
 */
async function resolveStart(projectId: string, start: QueueStart): Promise<Date> {
  if ('inMinutes' in start) return new Date(Date.now() + start.inMinutes * 60_000)
  const owner = (await getProjectRow(projectId))?.owner
  const zone = (owner !== undefined ? (await getTimeZone(owner)).timeZone : null) ?? 'UTC'
  const at = resolveStartAt(start.at, zone, new Date())
  if (at === undefined) {
    throw new ServerError('VALIDATION', `'${start.at}' is not a start time: give HH:MM, YYYY-MM-DD HH:MM, `
      + 'or an ISO 8601 time with an offset')
  }
  return at
}

/**
 * Edit a queued entry's fields or parent. A new tool without a model or
 * permission mode re-resolves those, and a stored effort the new tool or
 * model lacks is re-resolved too. A parent that would form a cycle is
 * refused. An agent's edit is held to its ceiling, counting the stored
 * permission mode as requested.
 */
export async function updateQueuedWorkspace(
  principal: Actor,
  id: string,
  patch: Partial<QueueRequest>,
  source: QueueSource,
): Promise<QueuedWorkspaceEntry> {
  const row = await editableRow(principal, id)
  if (patch.prompt !== undefined) checkPrompt(patch.prompt)
  if (patch.parent !== undefined && patch.start !== undefined) {
    throw new ServerError('VALIDATION', 'a queued workspace waits on a parent or starts at a time, not both')
  }
  // An entry left with no parent must still have a limited group to wait in.
  const parentless = patch.start === undefined
    && (patch.parent === null || (patch.parent === undefined && pointerOf(row) === null))
  const parent = patch.start !== undefined
    ? { pointer: { startAt: await resolveStart(row.projectId, patch.start) } }
    : parentless && (patch.parent === null || patch.group !== undefined)
      ? await roomToWaitIn(row.projectId, patch.group !== undefined ? patch.group : row.groupId ?? null)
      : patch.parent != null
        ? await resolveParent(row.projectId, patch.parent)
        : await parentInfo(row.projectId, pointerOf(row))
  const retooled = patch.tool !== undefined && patch.tool !== row.tool
  const keptEffort = patch.effort ?? (retooled ? undefined : keepableEffort(row, patch.model))
  const settings = await resolveSettings(row.projectId, parent, {
    prompt: patch.prompt ?? row.prompt,
    tool: patch.tool ?? row.tool,
    mode: patch.mode ?? row.mode,
    branch: patch.branch ?? row.branch,
    title: patch.title ?? row.title ?? '',
    group: parent.pointer === null && parent.groupId !== undefined ? parent.groupId
      : patch.group !== undefined ? patch.group : row.groupId ?? null,
    ...(patch.model !== undefined ? { model: patch.model } : retooled ? {} : { model: row.model }),
    ...(patch.permissionMode !== undefined
      ? { permissionMode: patch.permissionMode }
      : retooled ? {} : { permissionMode: row.permissionMode }),
    ...(keptEffort !== undefined ? { effort: keptEffort } : {}),
    timeout: patch.timeout !== undefined ? patch.timeout : row.timeoutMinutes ?? null,
  }, source)
  refuseDeletedParent(parent.pointer)
  const updated = await updateQueuedWorkspaceRow(id, {
    ...settings,
    ...(patch.parent !== undefined || patch.start !== undefined ? { parent: parent.pointer } : {}),
  })
  if (!updated) throw launchingConflict()
  const [entry] = await toEntries([updated])
  await startWaitingWorkspaces(row.projectId)
  return entry
}

/** An entry's stored effort, if the model it will run (a new one, or its
 *  own) has it. */
function keepableEffort(row: QueuedWorkspaceRow, model: string | undefined): string | undefined {
  if (row.effort === undefined) return undefined
  const levels = modelEfforts(row.tool, model ?? row.model)?.levels
  return levels?.includes(row.effort) === true ? row.effort : undefined
}

/** Discard an entry. Its children splice up to its own parent, so the
 *  children of one with no parent then wait for room themselves. */
export async function discardQueuedWorkspace(principal: Actor, id: string): Promise<void> {
  const row = await editableRow(principal, id)
  if (!await deleteQueuedWorkspace(id)) throw launchingConflict()
  await startWaitingWorkspaces(row.projectId)
}

/**
 * Run an entry now. Returns the new workspace id once the launch is claimed;
 * the launch continues detached as a provisioning row. Refused while its
 * group is at its workspace limit. Its timeout counts from now, except a
 * routine's run's, which counts from its tick so it never outlives the next
 * one (docs/routines.md).
 */
export async function runQueuedWorkspace(principal: Actor, id: string): Promise<{ workspaceId: string }> {
  const row = await editableRow(principal, id)
  refuseFullGroup(await readGroupRoom(row.projectId, row.groupId), '')
  const released = await releaseQueuedWorkspace(id)
  if (!released) throw launchingConflict()
  const launched = await launch(released,
    released.routineId !== undefined && released.startAt !== undefined ? released.startAt : new Date())
  if (launched === undefined) throw launchingConflict()
  // Released, so it starts as soon as a slot frees.
  if (launched === 'full') throw new ServerError('CONFLICT', 'its group filled up meanwhile; it starts once there is room')
  return launched
}

/** Release every entry waiting directly on a workspace that stopped, and
 *  launch what now has room, the stop's own slot included. */
export async function startQueuedChildren(projectId: string, workspaceId: string): Promise<void> {
  await releaseQueuedChildren(projectId, workspaceId)
  await startWaitingWorkspaces(projectId)
}

/**
 * Release every scheduled entry whose time has come and launch it where its
 * group has room, on the reconciler's resync (docs/routines.md). One that
 * failed waits for the user, and one whose group is full waits for room.
 */
export async function startScheduledWorkspaces(): Promise<void> {
  const released = await releaseDueQueuedWorkspaces(new Date())
  for (const projectId of new Set(released.map((r) => r.projectId))) await startWaitingWorkspaces(projectId)
}

/**
 * Launch every entry that waits only for room, oldest first, while its
 * group has a free slot: one released by its parent's stop or a "Run now",
 * and one queued with no parent. A group without a limit always has room.
 * Called wherever a slot may have freed (a stop or death, a failed create
 * or restart, a move out, a raised or cleared limit, a deleted group), and
 * once at boot (`resumeQueuedWorkspaces`).
 * A launch takes its slot before it claims the entry, so concurrent calls
 * cannot over-launch. One that failed waits for the user, as any failed
 * launch does. Never throws, since its callers' own writes have succeeded:
 * an entry it could not launch waits for the next slot that frees.
 */
export async function startWaitingWorkspaces(projectId?: string): Promise<void> {
  const rows = await listQueuedWorkspaceRows(projectId).catch((err: unknown) => {
    serverLog(`[queue] listing queued workspaces failed: ${String(err)}`)
    return []
  })
  // Once a group is full, its newer entries wait behind the older one.
  const full = new Set<string>()
  for (const row of rows.filter(waitsForRoom)) {
    const key = `${row.projectId}/${row.groupId ?? ''}`
    if (full.has(key)) continue
    try {
      // A scheduled entry's timeout counts from its start time, so one that
      // waited may find its window already gone.
      if (await launch(row, row.startAt ?? new Date()) === 'full') full.add(key)
    } catch (err) {
      serverLog(`[queue] launching queued workspace ${row.id.slice(0, 8)}... failed: ${String(err)}`)
    }
  }
}

function waitsForRoom(row: QueuedWorkspaceRow): boolean {
  return row.launchWorkspaceId === undefined && row.launchError === undefined
    && (row.releasedAt !== undefined || pointerOf(row) === null)
}

/**
 * Snapshot feed: entries not mid-launch (those show as provisioning rows),
 * oldest first. Entries whose parent workspace is gone are flagged
 * `orphaned`.
 */
export async function listQueuedWorkspaces(): Promise<QueuedWorkspaceEntry[]> {
  const rows = (await listQueuedWorkspaceRows()).filter((r) => r.launchWorkspaceId === undefined)
  return await toEntries(rows)
}

/** Snapshot feed: stopped workspaces that entries still wait on, so the
 *  entries have a row to nest under. */
export async function listHeldWorkspaces(): Promise<HeldWorkspaceEntry[]> {
  const waiting = (await listQueuedWorkspaceRows())
    .filter((r) => r.launchWorkspaceId === undefined && r.parentWorkspaceId !== undefined)
  if (waiting.length === 0) return []
  const parents = new Set(waiting.map((r) => `${r.projectId}/${r.parentWorkspaceId}`))
  const projectIds = [...new Set(waiting.map((r) => r.projectId))]
  const held = (await Promise.all(projectIds.map((projectId) => listWorkspaceRows(projectId)))).flat()
    .filter((w) => w.stoppedAt !== undefined && parents.has(`${w.projectId}/${w.workspaceId}`))
  // Only the held entry's own fields: the snapshot carries every one.
  return (await toStoppedEntries(held)).map(({ agentSessions: _, createdAt: __, lastActiveAt: ___, ...entry }) => entry)
}

/**
 * Pick the queue up where a previous server left it, once at boot:
 * - A claimed launch not running here was interrupted. If its workspace has
 *   a row and is running, the create got that far and the entry is
 *   finished, since running it again would start a second workspace beside
 *   it (routines make such restarts common, a tick's launch taking a few
 *   seconds). Otherwise it is marked failed. A half-made workspace that dies
 *   is a death like any other, and the stale reaper handles a dead one.
 * - Then whatever waits only for room is launched where there is room
 *   (`startWaitingWorkspaces`): a release the previous server never
 *   launched, and slots freed while no server ran.
 * After this, stops, deaths, failures and group edits launch directly, and
 * the resync starts scheduled entries (`startScheduledWorkspaces`).
 */
export async function resumeQueuedWorkspaces(): Promise<void> {
  for (const row of await listQueuedWorkspaceRows()) {
    // Per row: a "Run now" may have started since the read.
    const workspaceId = row.launchWorkspaceId
    if (workspaceId === undefined || launching.has(row.id)) continue
    try {
      const unit = await workspaceDriver().find(workspaceId)
      if (unit?.running === true && !unit.terminating && await findWorkspaceRow(workspaceId) !== undefined) {
        await finishQueuedLaunch(row.id, workspaceId)
      } else {
        await failQueuedLaunch(row.id, workspaceId,
          'interrupted by a server restart; run it again once you have checked what it left')
      }
    } catch (err) {
      serverLog(`[queue] resolving queued workspace ${row.id.slice(0, 8)}... failed: ${String(err)}`)
    }
  }
  await startWaitingWorkspaces()
}

/**
 * Take a slot in the entry's group and claim its launch, then start it
 * detached. Returns the new workspace's id, `'full'` if the group has no
 * room, or undefined if another launcher claimed it. Claiming first means a
 * double-click or a race starts only one workspace. The entry's timeout
 * counts from `timeoutFrom`; one already over fails the launch.
 */
async function launch(row: QueuedWorkspaceRow, timeoutFrom: Date): Promise<{ workspaceId: string } | 'full' | undefined> {
  if (launching.has(row.id)) return undefined
  const [room, nextTick] = await Promise.all([readGroupRoom(row.projectId, row.groupId), nextRunOf(row)])
  const workspaceId = crypto.randomUUID()
  // Synchronous from here to the reservation, so the slot is ours.
  if (launching.has(row.id)) return undefined
  if (groupFull(room, workspaceId)) return 'full'
  launching.add(row.id)
  const freeSlot = room !== undefined ? reserveGroupSlot(room.projectId, room.groupId, workspaceId) : () => {}
  let claimed = false
  try {
    claimed = await claimQueuedLaunch(row.id, workspaceId)
  } finally {
    if (!claimed) {
      launching.delete(row.id)
      freeSlot()
    }
  }
  if (!claimed) return undefined

  const deadline = nextTick ?? (row.timeoutMinutes !== undefined
    ? new Date(timeoutFrom.getTime() + row.timeoutMinutes * 60_000)
    : undefined)
  void (async () => {
    let failed = false
    try {
      if (deadline !== undefined && deadline.getTime() <= Date.now()) {
        // Run again, a routine's run counts from its tick once more, so only
        // the routine can give it a fresh window.
        throw new Error(nextTick !== undefined
          ? 'its window ended at the routine\'s next tick; start a fresh run from the routine'
          : row.routineId !== undefined
            ? 'its timeout ran out before it could start; start a fresh run from the routine'
            : 'its scheduled window passed before it could start; run it again to give it a fresh one')
      }
      // The server launches it: whoever queued or ran the entry was
      // authorized then.
      const run = await prepareStart(systemPrincipal, {
        projectId: row.projectId,
        workspaceId,
        tool: row.tool,
        model: row.model,
        mode: row.mode,
        permissionMode: row.permissionMode,
        ...(row.effort !== undefined ? { effort: row.effort } : {}),
        branch: row.branch,
        prompt: row.prompt,
        ...(row.title !== undefined ? { title: row.title } : {}),
        ...(row.title === undefined && row.generatedTitle !== undefined ? { generatedTitle: row.generatedTitle } : {}),
        ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
        rememberDefaults: false,
        // Children point at `workspaceId`; a spare has a different id.
        claimSpare: false,
      })
      await run()
      // The listings say "ended at next run" for such a stop, not "timed out".
      if (nextTick !== undefined) await markDeadlineIsNextRun(row.projectId, workspaceId)
      await finishQueuedLaunch(row.id, workspaceId)
    } catch (err) {
      failed = true
      // Show the error on the queued row only, not as a provisioning row. A
      // stop is no error: the entry just goes back to waiting, except one
      // that would relaunch at once: one with no parent, or one whose start
      // time has passed.
      const error = err instanceof ProvisionStoppedError
        ? pointerOf(row) === null ? 'stopped before its agent started'
          : row.startAt !== undefined ? 'stopped before it started; run it again when you are ready'
          : null
        : err instanceof Error ? err.message : String(err)
      await failQueuedLaunch(row.id, workspaceId, error)
        .catch((e: unknown) => serverLog(`[queue] recording a failed launch failed: ${String(e)}`))
      removeProvisioning(workspaceId)
    } finally {
      launching.delete(row.id)
      freeSlot()
    }
    // Its slot is free only now that its reservation is gone.
    if (failed) await startWaitingWorkspaces(row.projectId)
  })()
  return { workspaceId }
}

/**
 * When a routine's run with no timeout of its own stops: its routine's next
 * tick after the run's start, exactly, so it never overlaps the next run,
 * even one started seconds before a tick (whole minutes could not say so).
 * Undefined for any other entry.
 */
async function nextRunOf(row: QueuedWorkspaceRow): Promise<Date | undefined> {
  if (row.routineId === undefined || row.startAt === undefined) return undefined
  const routine = await getRoutineRow(row.routineId)
  if (routine === undefined || routine.timeoutMinutes !== undefined) return undefined
  return nextCronRuns(routine.cron, routine.timeZone, row.startAt, 1)[0]
}

/** An entry that exists and is not mid-launch — what every edit needs. */
async function editableRow(principal: Actor, id: string): Promise<QueuedWorkspaceRow> {
  const row = await getQueuedWorkspaceRow(id)
  if (!row) throw new ServerError('NOT_FOUND', `no queued workspace ${id}`)
  await authorizeProject(principal, row.projectId)
  if (row.launchWorkspaceId !== undefined || launching.has(id)) throw launchingConflict()
  return row
}

function launchingConflict(): ServerError {
  return new ServerError('CONFLICT', 'that queued workspace is launching')
}

function checkPrompt(prompt: string): void {
  if (prompt.trim() === '') {
    throw new ServerError('VALIDATION', 'a queued workspace needs a prompt — nobody is watching it start')
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ServerError('VALIDATION', PROMPT_TOO_LONG)
  }
}

/**
 * Refuse a parent workspace a delete holds, right before the write, since an
 * entry under it would wait on a parent that can never stop.
 */
function refuseDeletedParent(pointer: QueuedParent): void {
  if (pointer !== null && 'parentWorkspaceId' in pointer) refuseDeleting(pointer.parentWorkspaceId)
}

/** What an entry waits on; null only for one waiting for room, never a
 *  scheduled one. */
function pointerOf(row: QueuedWorkspaceRow): QueuedParent {
  return row.parentQueuedId !== undefined ? { parentQueuedId: row.parentQueuedId }
    : row.parentWorkspaceId !== undefined ? { parentWorkspaceId: row.parentWorkspaceId }
    : row.startAt !== undefined ? { startAt: row.startAt }
    : null
}

/**
 * An entry with no parent waits for room in a group, so the group must
 * exist and have a workspace limit: an unlimited group never needs waiting
 * for. `group` is an id or name; an unknown name is refused, not created.
 */
async function roomToWaitIn(projectId: string, group: string | null | undefined): Promise<ParentInfo> {
  const instead = 'Use create to start it now, or give it a parent workspace to queue after.'
  if (group == null) {
    throw new ServerError('VALIDATION', `a queued workspace with no parent needs a group with a workspace limit to wait in. ${instead}`)
  }
  const resolved = await resolveGroup(projectId, group).catch((err: unknown) => {
    if (!(err instanceof ServerError && err.code === 'NOT_FOUND')) throw err
    throw new ServerError('VALIDATION', `no group "${group}" in this project; a queued workspace with no parent `
      + `waits for room in an existing group with a workspace limit. ${instead}`)
  })
  if (resolved.workspaceLimit === undefined) {
    throw new ServerError('VALIDATION', `group "${resolved.name}" has no workspace limit, so a workspace never `
      + `waits for room in it. ${instead}`)
  }
  return { pointer: null, groupId: resolved.groupId }
}

/**
 * Resolve a parent: a workspace or entry in the project, by id or unique
 * prefix. A launching entry resolves to its new workspace. The full id of a
 * create still in flight also works, so
 * `id=$(yaac-mama create …); yaac-mama queue --parent-workspace "$id"` does
 * not race the row write.
 */
async function resolveParent(projectId: string, parent: string): Promise<ParentInfo> {
  const target = parent.trim()
  const [workspace, entries] = await Promise.all([
    resolveWorkspace(target, { projectId }),
    listQueuedWorkspaceRows(projectId),
  ])
  const asWorkspace = (workspaceId: string): Promise<ParentInfo> =>
    parentInfo(projectId, { parentWorkspaceId: workspaceId })
  // A full id wins outright; only a prefix can be ambiguous.
  if (workspace.ok && workspace.workspaceId === target) return await asWorkspace(target)
  if (inFlightCreate(target)?.projectId === projectId) return await asWorkspace(target)
  let entry = entries.find((e) => e.id === target)
  if (entry === undefined) {
    const prefixed = target === '' ? [] : entries.filter((e) => e.id.startsWith(target))
    const workspaceMatches = workspace.ok ? 1 : workspace.reason === 'ambiguous' ? 2 : 0
    if (workspaceMatches + prefixed.length > 1) {
      throw new ServerError(
        'VALIDATION',
        `'${target}' matches more than one workspace or queued workspace in ${projectId} — use a longer prefix`,
      )
    }
    if (workspace.ok) return await asWorkspace(workspace.workspaceId)
    entry = prefixed[0]
  }
  if (entry === undefined) {
    throw new ServerError('NOT_FOUND', `no workspace or queued workspace '${target}' in ${projectId}`)
  }
  return {
    ...settingsOf(entry),
    pointer: entry.launchWorkspaceId !== undefined
      ? { parentWorkspaceId: entry.launchWorkspaceId }
      : { parentQueuedId: entry.id },
  }
}

/** A parent's defaults: an entry's stored settings, or a workspace's first
 *  conversation (current model) and row, falling back to what an in-flight
 *  create asked for. */
async function parentInfo(projectId: string, pointer: QueuedParent): Promise<ParentInfo> {
  if (pointer === null || 'startAt' in pointer) return { pointer }
  if ('parentQueuedId' in pointer) {
    const entry = await getQueuedWorkspaceRow(pointer.parentQueuedId)
    return { pointer, ...(entry !== undefined ? settingsOf(entry) : {}) }
  }
  const workspaceId = pointer.parentWorkspaceId
  const [row, first] = await Promise.all([
    getProjectWorkspaceRows(projectId).then((rows) => rows.get(workspaceId)),
    firstAgentSession(projectId, workspaceId),
  ])
  const creating = inFlightCreate(workspaceId)
  // The conversation's model is as its agent reported it, which anything in
  // the workspace can set, so only a launchable one is inherited.
  const reported = first?.model !== undefined ? launchableModel(first.tool, first.model) : undefined
  const model = reported ?? row?.model ?? creating?.model
  const mode = first?.mode ?? row?.mode
  const tool = first?.tool ?? creating?.tool
  const branch = row?.baseBranch ?? creating?.branch
  const groupId = row !== undefined ? row.groupId : creating?.groupId
  return {
    pointer,
    ...(tool !== undefined ? { tool } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(row !== undefined ? { permissionMode: row.permissionMode } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

function settingsOf(entry: QueuedWorkspaceRow): Omit<ParentInfo, 'pointer'> {
  return {
    tool: entry.tool,
    mode: entry.mode,
    model: entry.model,
    permissionMode: entry.permissionMode,
    branch: entry.branch,
    ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
  }
}

/**
 * Resolve every setting: the request's, else the parent's (tool-specific ones
 * only for the same tool), else the project's create defaults. The group is
 * fixed now, so moving the parent later does not move it.
 */
async function resolveSettings(
  projectId: string,
  parent: ParentInfo,
  request: Omit<QueueRequest, 'parent' | 'start'>,
  source: QueueSource,
): Promise<QueuedWorkspaceSettings> {
  const tool = request.tool ?? parent.tool ?? (await getProjectRow(projectId))?.lastTool ?? 'claude'
  const sameTool = tool === parent.tool
  // The UI mode is not tool-specific, so it is borrowed whatever the tool.
  // With the parent's tool unknown, borrow the permission mode (checked
  // below) but not the model.
  const compatible = sameTool || parent.tool === undefined
  const mode = request.mode ?? parent.mode
  const inherited = compatible ? parent.permissionMode : undefined

  // An agent's permission mode is capped at its own (`agentPermissionMode`).
  let permissionMode = request.permissionMode
  if (source !== 'user') {
    const resolved = agentPermissionMode(
      tool,
      source.ceiling,
      request.permissionMode,
      parent.permissionMode ?? source.ceiling,
    )
    if (!resolved.ok) throw new ServerError('VALIDATION', resolved.error)
    permissionMode = resolved.permissionMode
  } else if (
    permissionMode === undefined && inherited !== undefined
    && toolSupportsPermissionMode(tool, inherited)
  ) {
    permissionMode = inherited
  }

  const setup = await resolveCreate(projectId, {
    tool,
    ...(mode !== undefined ? { mode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.model !== undefined
      ? { model: request.model }
      : sameTool && parent.model !== undefined ? { model: parent.model } : {}),
  })
  if (setup.model === undefined) {
    throw new ServerError('VALIDATION', `no model is known for ${setup.tool}; pick one`)
  }
  const title = normalizeTitle(request.title ?? '')
  const groupId = request.group === undefined ? parent.groupId
    : request.group === null ? undefined
    : (await resolveGroup(projectId, request.group, { create: true })).groupId
  return {
    prompt: request.prompt,
    tool: setup.tool,
    model: setup.model,
    mode: setup.mode,
    permissionMode: setup.permissionMode,
    ...(setup.effort !== undefined ? { effort: setup.effort } : {}),
    branch: request.branch ?? parent.branch ?? await getDefaultBranch(repoDir(projectId)),
    ...(title !== '' ? { title } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.timeout != null ? { timeoutMinutes: request.timeout } : {}),
  }
}

/**
 * Settings for an entry with no parent to inherit from (a routine's runs):
 * the request's, else the project's create defaults. An agent's posture
 * defaults to its ceiling.
 */
export async function resolveParentlessSettings(
  projectId: string,
  request: Omit<QueueRequest, 'parent' | 'start'>,
  source: QueueSource,
): Promise<QueuedWorkspaceSettings> {
  return await resolveSettings(projectId, { pointer: { startAt: new Date() } }, request, source)
}

/** Wire entries, flagging the ones whose parent workspace is gone. */
async function toEntries(rows: QueuedWorkspaceRow[]): Promise<QueuedWorkspaceEntry[]> {
  if (rows.length === 0) return []
  const projectIds = [...new Set(rows.map((r) => r.projectId))]
  const known = new Set((await Promise.all(projectIds.map(async (projectId) =>
    [...(await getProjectWorkspaceRows(projectId)).keys()].map((id) => `${projectId}/${id}`)))).flat())
  for (const p of listProvisioning()) known.add(`${p.projectId}/${p.workspaceId}`)
  return rows.map((r) => {
    const modelName = modelDisplayName(r.tool, r.model)
    const orphaned = r.parentWorkspaceId !== undefined && !known.has(`${r.projectId}/${r.parentWorkspaceId}`)
    return {
      id: r.id,
      projectId: r.projectId,
      ...(r.parentWorkspaceId !== undefined ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
      ...(r.parentQueuedId !== undefined ? { parentQueuedId: r.parentQueuedId } : {}),
      ...(r.startAt !== undefined ? { startAt: r.startAt.toISOString() } : {}),
      ...(r.timeoutMinutes !== undefined ? { timeoutMinutes: r.timeoutMinutes } : {}),
      ...(r.routineId !== undefined ? { routineId: r.routineId } : {}),
      prompt: r.prompt,
      tool: r.tool,
      model: r.model,
      ...(modelName !== undefined ? { modelName } : {}),
      mode: r.mode,
      permissionMode: r.permissionMode,
      ...(r.effort !== undefined ? { effort: r.effort } : {}),
      branch: r.branch,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.generatedTitle !== undefined ? { generatedTitle: r.generatedTitle } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      ...(r.launchError !== undefined ? { launchError: r.launchError } : {}),
      ...(orphaned ? { orphaned: true } : {}),
      ...(waitsForRoom(r) ? { waitingForRoom: true } : {}),
    }
  })
}

/** Test helper: forget which launches this process is running. */
export function clearQueuedLaunchesForTests(): void {
  launching.clear()
}
