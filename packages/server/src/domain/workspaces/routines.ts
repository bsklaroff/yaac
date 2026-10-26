/**
 * Routines (docs/routines.md): a cron schedule that starts a fresh workspace
 * on every tick. A tick inserts a queued entry whose `startAt` is the tick,
 * and the queue launches it, so routines add no launch path of their own.
 * A routine with no timeout gives each run one that ends at the next tick,
 * so runs never overlap.
 *
 * Settings are resolved when the routine is saved, as a queued entry's are,
 * so what the UI shows is what each run launches with.
 */
import { resolveParentlessSettings, runQueuedWorkspace } from './queued-workspaces'
import { authorizeProject, type Actor } from '#domain/access'
import { modelDisplayName } from '#domain/auth'
import {
  deleteQueuedWorkspace,
  deleteRoutine as deleteRoutineRow,
  getProjectRow,
  getRoutineRow,
  getTimeZone,
  insertRoutine,
  insertRoutineRun,
  listProjectRows,
  listQueuedWorkspaceRows,
  listRoutineRows,
  listRoutineRuns,
  listUnlaunchedRoutineRuns,
  setRoutinePaused as setRoutinePausedRow,
  updateRoutine as updateRoutineRow,
  type QueuedWorkspaceRow,
  type RoutineFields,
  type RoutineRow,
  type RoutineRunRow,
} from '#db'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { cronError, formatInZone, isTimeZone, latestCronRun, nextCronRuns } from '@yaac/shared/schedule'
import { formatUtcTimestamp } from '@yaac/shared/time'
import {
  ROUTINE_RUNS_PAGE_MAX,
  type RoutineEntry,
  type RoutineRunEntry,
  type RoutineRunPage,
  type RoutineSettings,
} from '@yaac/shared/types'

/** Create a routine. Its first tick is the cron's next one from now. */
export async function createRoutine(
  principal: Actor,
  projectId: string,
  request: RoutineSettings,
): Promise<RoutineEntry> {
  await authorizeProject(principal, projectId)
  const fields = await resolveRoutine(projectId, request)
  const row = await insertRoutine(projectId, fields, nextTick(fields.cron, fields.timeZone, new Date()))
  return (await toEntries([row]))[0]
}

/**
 * Change any of a routine's fields. A new cron or zone re-reads its next
 * tick from now (unless it is paused); otherwise its schedule state is left
 * alone, so a tick fired since `row` was read is not fired again. A new tool
 * without a model or permission mode re-resolves those. Runs already started
 * keep the deadlines they launched with.
 */
export async function updateRoutine(
  principal: Actor,
  id: string,
  patch: Partial<RoutineSettings>,
): Promise<RoutineEntry> {
  const row = await routineFor(principal, id)
  const retooled = patch.tool !== undefined && patch.tool !== row.tool
  const fields = await resolveRoutine(row.projectId, {
    name: patch.name ?? row.name,
    cron: patch.cron ?? row.cron,
    timeZone: patch.timeZone ?? row.timeZone,
    prompt: patch.prompt ?? row.prompt,
    tool: patch.tool ?? row.tool,
    mode: patch.mode ?? row.mode,
    branch: patch.branch ?? row.branch,
    group: patch.group !== undefined ? patch.group : row.groupId ?? null,
    timeout: patch.timeout !== undefined ? patch.timeout : row.timeoutMinutes ?? null,
    ...(patch.model !== undefined ? { model: patch.model } : retooled ? {} : { model: row.model }),
    ...(patch.permissionMode !== undefined
      ? { permissionMode: patch.permissionMode }
      : retooled ? {} : { permissionMode: row.permissionMode }),
    ...(patch.effort !== undefined ? { effort: patch.effort }
      : !retooled && patch.model === undefined && row.effort !== undefined ? { effort: row.effort } : {}),
  })
  const rescheduled = fields.cron !== row.cron || fields.timeZone !== row.timeZone
  const updated = await updateRoutineRow(id, fields,
    rescheduled && !row.paused ? nextTick(fields.cron, fields.timeZone, new Date()) : undefined)
  if (!updated) throw new ServerError('NOT_FOUND', `no routine ${id}`)
  return (await toEntries([updated]))[0]
}

/** Pause a routine, or resume it from the cron's next tick (missed ticks
 *  are not caught up). */
export async function setRoutinePaused(principal: Actor, id: string, paused: boolean): Promise<RoutineEntry> {
  const row = await routineFor(principal, id)
  const updated = await setRoutinePausedRow(id, paused, paused ? null : nextTick(row.cron, row.timeZone, new Date()))
  if (!updated) throw new ServerError('NOT_FOUND', `no routine ${id}`)
  return (await toEntries([updated]))[0]
}

/**
 * Start a run now, outside the schedule, without moving the next tick. With
 * no timeout of its own the run stops at the next scheduled tick. Returns
 * the new workspace id once its launch is claimed.
 */
export async function runRoutineNow(principal: Actor, id: string): Promise<{ workspaceId: string }> {
  const row = await routineFor(principal, id)
  const now = new Date()
  const entry = await insertRun(row, now, nextTick(row.cron, row.timeZone, now))
  if (!entry) throw new ServerError('NOT_FOUND', `no routine ${id}`)
  // A refusal (its group is full) leaves no entry behind to start later.
  return await runQueuedWorkspace(principal, entry.id).catch(async (err: unknown) => {
    await deleteQueuedWorkspace(entry.id).catch(() => false)
    throw err
  })
}

/** Delete a routine and the runs it queued that never launched. Running
 *  ones keep going until their deadlines. */
export async function deleteRoutine(principal: Actor, id: string): Promise<void> {
  await routineFor(principal, id)
  await discardUnlaunchedRuns(id)
  if (!await deleteRoutineRow(id)) throw new ServerError('NOT_FOUND', `no routine ${id}`)
}

/** Snapshot feed: every project's routines, oldest first. */
export async function listRoutines(): Promise<RoutineEntry[]> {
  return await toEntries(await listRoutineRows())
}

/** A routine's runs, newest first, a page at a time. Readable by anyone
 *  who may read the project. */
export async function listRoutineRunPage(
  id: string,
  opts: { limit?: number; cursor?: string },
): Promise<RoutineRunPage> {
  const row = await getRoutineRow(id)
  if (!row) throw new ServerError('NOT_FOUND', `no routine ${id}`)
  const limit = Math.min(opts.limit ?? 25, ROUTINE_RUNS_PAGE_MAX)
  const before = parseCursor(opts.cursor)
  // One past the page, to tell whether another follows.
  const rows = await listRoutineRuns(id, limit + 1, before)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    runs: page.map(toRun),
    ...(rows.length > limit && last?.startAt !== undefined
      ? { nextCursor: `${last.startAt.getTime()}:${last.id}` }
      : {}),
  }
}

/**
 * Fire every routine whose tick has come, on the reconciler's resync. Runs
 * before the queue's step, which launches what this inserts in the same
 * pass. A routine in a removed share runs nothing.
 */
export async function reconcileRoutines(): Promise<void> {
  const now = new Date()
  const revoked = new Set((await listProjectRows()).filter((p) => p.shareRevoked).map((p) => p.id))
  for (const row of await listRoutineRows()) {
    if (row.paused || row.nextRunAt === undefined || row.nextRunAt > now || revoked.has(row.projectId)) continue
    await fire(row, row.nextRunAt, now)
      .catch((err: unknown) => serverLog(`[routines] firing ${row.name} (${row.id.slice(0, 8)}) failed: ${String(err)}`))
  }
}

/**
 * Fire one tick. Ticks missed while the server was down collapse into the
 * latest of them, so there is no backlog of catch-up runs. Moving the next
 * tick (by compare-and-set) and queueing the run are one transaction, so a
 * tick fires exactly once: a racing pass or pause wins or loses whole, and a
 * failure leaves the tick due.
 */
async function fire(row: RoutineRow, due: Date, now: Date): Promise<void> {
  const slot = latestCronRun(row.cron, row.timeZone, now) ?? due
  const following = nextTick(row.cron, row.timeZone, now)
  await insertRun(row, slot, following, { from: due, to: following })
}

/**
 * Queue one run starting at `slot` (`insertRoutineRun`, which also replaces
 * the routine's runs that never launched). Its timeout is the routine's,
 * else the gap to `following` in whole minutes, which the listings show;
 * the launch then stops such a run at the next tick exactly.
 */
async function insertRun(
  row: RoutineRow,
  slot: Date,
  following: Date | null,
  advance?: { from: Date; to: Date | null },
): Promise<QueuedWorkspaceRow | undefined> {
  const timeoutMinutes = row.timeoutMinutes
    ?? (following !== null ? Math.max(1, Math.floor((following.getTime() - slot.getTime()) / 60_000)) : undefined)
  return await insertRoutineRun(row.id, row.projectId, slot, {
    prompt: row.prompt,
    tool: row.tool,
    model: row.model,
    mode: row.mode,
    permissionMode: row.permissionMode,
    ...(row.effort !== undefined ? { effort: row.effort } : {}),
    branch: row.branch,
    title: `${row.name} · ${formatInZone(slot, row.timeZone)}`,
    ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
    ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
  }, advance)
}

async function discardUnlaunchedRuns(routineId: string): Promise<void> {
  const stale = (await listQueuedWorkspaceRows())
    .filter((e) => e.routineId === routineId && e.launchWorkspaceId === undefined)
  for (const e of stale) await deleteQueuedWorkspace(e.id)
}

/** A routine the caller may edit. */
async function routineFor(principal: Actor, id: string): Promise<RoutineRow> {
  const row = await getRoutineRow(id)
  if (!row) throw new ServerError('NOT_FOUND', `no routine ${id}`)
  await authorizeProject(principal, row.projectId)
  return row
}

/** The cron's next tick after `from`; null for one that never fires again
 *  (a date that does not exist, say). */
function nextTick(cron: string, timeZone: string, from: Date): Date | null {
  return nextCronRuns(cron, timeZone, from, 1)[0] ?? null
}

/**
 * Check and resolve a routine's fields. The zone defaults to the project
 * owner's, else UTC; a create that names no group files runs under one
 * named after the routine, made if need be.
 */
async function resolveRoutine(projectId: string, request: RoutineSettings): Promise<RoutineFields> {
  const cron = request.cron.trim()
  const invalid = cronError(cron)
  if (invalid !== undefined) throw new ServerError('VALIDATION', `invalid cron '${cron}': ${invalid}`)
  const timeZone = request.timeZone ?? await ownerTimeZone(projectId)
  if (!isTimeZone(timeZone)) throw new ServerError('VALIDATION', `'${timeZone}' is not an IANA time zone`)
  const name = request.name.trim()
  const settings = await resolveParentlessSettings(projectId, {
    prompt: request.prompt,
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    group: request.group !== undefined ? request.group : name,
  })
  return {
    name,
    cron,
    timeZone,
    prompt: settings.prompt,
    tool: settings.tool,
    model: settings.model,
    mode: settings.mode,
    permissionMode: settings.permissionMode,
    ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
    branch: settings.branch,
    ...(settings.groupId !== undefined ? { groupId: settings.groupId } : {}),
    ...(request.timeout != null ? { timeoutMinutes: request.timeout } : {}),
  }
}

async function ownerTimeZone(projectId: string): Promise<string> {
  const owner = (await getProjectRow(projectId))?.owner
  return (owner !== undefined ? (await getTimeZone(owner)).timeZone : null) ?? 'UTC'
}

function parseCursor(cursor: string | undefined): { startAt: Date; id: string } | undefined {
  const m = cursor !== undefined ? /^(\d+):(.+)$/.exec(cursor) : null
  return m ? { startAt: new Date(Number(m[1])), id: m[2] } : undefined
}

/** A run as its routine's history shows it. One stopped at a deadline that
 *  was its routine's next tick ended because the next run began, which says
 *  more than "timed out". */
function toRun(r: RoutineRunRow): RoutineRunEntry {
  const state: RoutineRunEntry['state'] = r.workspaceId === undefined
    ? r.launchError !== undefined ? 'failed' : 'waiting'
    : r.stoppedAt === undefined ? 'running'
    // A timeout is a natural stop, with no death reason; one that died after
    // its deadline died.
    : r.deathReason !== undefined ? 'died'
    : r.deadline !== undefined && r.stoppedAt >= r.deadline
      ? r.deadlineIsNextRun === true ? 'ended' : 'timed-out'
    : 'stopped'
  return {
    id: r.id,
    state,
    ...(r.startAt !== undefined ? { startAt: r.startAt.toISOString() } : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.launchError !== undefined && r.workspaceId === undefined ? { launchError: r.launchError } : {}),
    ...(r.workspaceId !== undefined ? { workspaceId: r.workspaceId } : {}),
    ...(state === 'running' && r.deadline !== undefined ? { deadline: r.deadline.toISOString() } : {}),
    ...(r.deathReason !== undefined && state === 'died' ? { deathReason: r.deathReason } : {}),
  }
}

async function toEntries(rows: RoutineRow[]): Promise<RoutineEntry[]> {
  if (rows.length === 0) return []
  const now = new Date()
  // The newest unlaunched run of each routine; its error is the routine's.
  const unlaunched = new Map((await listUnlaunchedRoutineRuns()).map((r) => [r.routineId, r] as const))
  return rows.map((r) => {
    const modelName = modelDisplayName(r.tool, r.model)
    const lastError = unlaunched.get(r.id)?.launchError
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      cron: r.cron,
      timeZone: r.timeZone,
      prompt: r.prompt,
      tool: r.tool,
      model: r.model,
      ...(modelName !== undefined ? { modelName } : {}),
      mode: r.mode,
      permissionMode: r.permissionMode,
      ...(r.effort !== undefined ? { effort: r.effort } : {}),
      branch: r.branch,
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
      ...(r.timeoutMinutes !== undefined ? { timeoutMinutes: r.timeoutMinutes } : {}),
      paused: r.paused,
      nextRuns: r.paused ? [] : nextCronRuns(r.cron, r.timeZone, now, 3).map((d) => d.toISOString()),
      ...(r.lastRunAt !== undefined ? { lastRunAt: r.lastRunAt.toISOString() } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
    }
  })
}
