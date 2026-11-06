import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  deleteProjectRoutines,
  deleteRoutine,
  getRoutineRow,
  insertRoutine,
  listRoutineRows,
  listRoutineRuns,
  listUnlaunchedRoutineRuns,
  routineRunWorkspaces,
  setRoutinePaused,
  updateRoutine,
  type RoutineFields,
} from '#db/routine-store'
import {
  claimQueuedLaunch,
  failQueuedLaunch,
  finishQueuedLaunch,
  getQueuedWorkspaceRow,
  insertQueuedWorkspace,
  insertRoutineRun,
  listQueuedWorkspaceRows,
} from '#db/queued-workspace-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { createWorkspaceGroup, deleteWorkspaceGroup } from '#db/group-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

describe('routine store', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const first = new Date('2026-10-24T09:00:00Z')
  const fields: RoutineFields = {
    name: 'Nightly', cron: '0 9 * * *', timeZone: 'UTC', prompt: 'triage', tool: 'claude', model: 'opus',
    mode: 'acp', permissionMode: 'bypass', branch: 'main',
  }
  const runSettings = {
    prompt: 'triage', tool: 'claude', model: 'opus', mode: 'acp', permissionMode: 'bypass', branch: 'main',
  } as const
  const run = (routineId: string, startAt: Date, prompt = 'triage') => insertQueuedWorkspace(PROJ, { startAt }, {
    prompt, tool: 'claude', model: 'opus', mode: 'acp', permissionMode: 'bypass', branch: 'main',
  }, { routineId })

  it('stores, replaces and lists routines, leaving the schedule to the calls that own it', async () => {
    const r = await insertRoutine(PROJ, { ...fields, groupId: 'g1', timeoutMinutes: 30 }, first)
    expect(pushes).toBe(1)
    expect(r).toMatchObject({ name: 'Nightly', groupId: 'g1', timeoutMinutes: 30, nextRunAt: first, paused: false })
    expect(await getRoutineRow('not-a-uuid')).toBeUndefined()
    await insertRoutine(OTHER, { ...fields, name: 'Other' }, null)
    expect((await listRoutineRows(PROJ)).map((x) => x.name)).toEqual(['Nightly'])
    expect(await listRoutineRows()).toHaveLength(2)

    // A replace clears what it leaves out, and keeps the next tick unless given one.
    const replaced = await updateRoutine(r.id, fields)
    expect(replaced?.groupId).toBeUndefined()
    expect(replaced?.timeoutMinutes).toBeUndefined()
    expect(replaced?.nextRunAt).toEqual(first)
    const next = new Date('2026-10-25T09:00:00Z')
    expect((await updateRoutine(r.id, fields, next))?.nextRunAt).toEqual(next)
    expect(await setRoutinePaused(r.id, true, null)).toMatchObject({ paused: true, name: 'Nightly' })
    expect((await getRoutineRow(r.id))?.nextRunAt).toBeUndefined()

    const group = await createWorkspaceGroup(PROJ, 'Runs', null)
    await updateRoutine(r.id, { ...fields, groupId: group.groupId })
    await deleteWorkspaceGroup(PROJ, group.groupId)
    expect((await getRoutineRow(r.id))?.groupId).toBeUndefined()

    expect(await deleteRoutine(r.id)).toBe(true)
    expect(await deleteRoutine(r.id)).toBe(false)
    await deleteProjectRoutines(OTHER)
    expect(await listRoutineRows()).toEqual([])
  })

  it('queues a tick\'s run once, with the move of the next tick, replacing runs that never launched', async () => {
    const r = await insertRoutine(PROJ, fields, first)
    const next = new Date('2026-10-25T09:00:00Z')
    const run = await insertRoutineRun(r.id, PROJ, first, runSettings, { from: first, to: next })
    expect(run).toMatchObject({ routineId: r.id, startAt: first })
    expect(await getRoutineRow(r.id)).toMatchObject({ nextRunAt: next, lastRunAt: first })
    // The second pass on the same tick finds it moved, and writes nothing.
    expect(await insertRoutineRun(r.id, PROJ, first, runSettings, { from: first, to: next })).toBeUndefined()
    expect((await listQueuedWorkspaceRows(PROJ)).filter((e) => e.routineId === r.id)).toHaveLength(1)

    // Something queued after the run that never launched follows the run
    // that replaces it, rather than taking over its past start time.
    const child = await insertQueuedWorkspace(PROJ, { parentQueuedId: run!.id }, { ...runSettings, prompt: 'after' })
    const again = await insertRoutineRun(r.id, PROJ, next, runSettings)
    expect(await getQueuedWorkspaceRow(run!.id)).toBeUndefined()
    expect(await getQueuedWorkspaceRow(child.id)).toMatchObject({ parentQueuedId: again!.id })
    expect((await getQueuedWorkspaceRow(child.id))?.startAt).toBeUndefined()

    // A paused routine never fires.
    await setRoutinePaused(r.id, true, null)
    expect(await insertRoutineRun(r.id, PROJ, next, runSettings, { from: next, to: next })).toBeUndefined()
  })

  it('lists a routine\'s runs newest first, a page at a time, with the state of what each became', async () => {
    const r = await insertRoutine(PROJ, fields, first)
    const days = [21, 22, 23].map((d) => new Date(`2026-10-${d}T09:00:00Z`))
    const [stopped, failed, waiting] = await Promise.all(days.map((d) => run(r.id, d)))
    await claimQueuedLaunch(stopped.id, 'wt-1')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-1', deadline: days[1] })
    await finishQueuedLaunch(stopped.id, 'wt-1')
    await recordWorkspaceStopped(PROJ, 'wt-1')
    await claimQueuedLaunch(failed.id, 'wt-2')
    await failQueuedLaunch(failed.id, 'wt-2', 'no such branch')

    const page = await listRoutineRuns(r.id, 2)
    expect(page.map((x) => x.id)).toEqual([waiting.id, failed.id])
    expect(page[1]).toMatchObject({ launchError: 'no such branch' })
    expect(page[1].workspaceId).toBeUndefined()
    const rest = await listRoutineRuns(r.id, 2, { startAt: days[1], id: failed.id })
    expect(rest).toEqual([expect.objectContaining({ id: stopped.id, workspaceId: 'wt-1', deadline: days[1] })])
    expect(rest[0].stoppedAt).toBeInstanceOf(Date)

    expect(await routineRunWorkspaces()).toEqual(new Map([['wt-1', r.id]]))
    // Oldest first, so the newest of a routine's wins when keyed.
    expect((await listUnlaunchedRoutineRuns()).map((x) => x.id)).toEqual([failed.id, waiting.id])

    // Deleting the routine leaves its runs as plain entries.
    await deleteRoutine(r.id)
    expect((await getQueuedWorkspaceRow(waiting.id))?.routineId).toBeUndefined()
  })
})
