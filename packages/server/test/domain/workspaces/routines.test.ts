import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'

// A stop's detached teardown is a spawned shell; it exits at once.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: ChildProcessModule.SpawnOptions) => {
      if (cmd !== 'sh') return actual.spawn(cmd, args, opts)
      const child = Object.assign(new EventEmitter(), { unref: () => { /* detached */ } })
      setImmediate(() => child.emit('exit', 0))
      return child
    },
  }
})
import {
  listStoppedWorkspaces,
  queueWorkspace,
  createRoutine,
  deleteRoutine,
  listRoutineRunPage,
  listRoutines,
  startScheduledWorkspaces,
  reconcileRoutines,
  runRoutineNow,
  setRoutinePaused,
  updateRoutine,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { listQueuedWorkspaceRows, claimQueuedLaunch, failQueuedLaunch } from '#db/queued-workspace-store'
import { getRoutineRow, setRoutinePaused as setRoutinePausedRow } from '#db/routine-store'
import { BUILT_IN_USER_ID, getWorkspaceRow, listWorkspaceGroupRows, setTimeZone } from '#db'
import { clearWorkspaceStopped, recordWorkspaceStopped, setWorkspaceDeadline } from '#db/workspace-store'
import { closeDb, getDb } from '#db/client'
import { workspaces } from '#db/schema'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { latestCronRun, nextCronRuns } from '@yaac/shared/schedule'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
let launched: string[]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  launched = []
  installFakeWorkspaceDriver({
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
    },
  })
})

afterEach(async () => {
  vi.useRealTimers()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const routine = (over: Partial<Parameters<typeof createRoutine>[2]> = {}) =>
  createRoutine(local, PROJ, { name: 'Nightly triage', cron: '0 9 * * *', prompt: 'triage the issues', tool: 'claude', ...over })

/** Make a routine's next tick already due, as the clock moving past it
 *  would. */
async function due(id: string, at: Date): Promise<void> {
  await setRoutinePausedRow(id, false, at)
}

/** The routine's queued runs, launched ones excluded. */
const runsOf = async (id: string) => (await listQueuedWorkspaceRows(PROJ)).filter((e) => e.routineId === id)

describe('createRoutine', () => {
  it('resolves its settings, reads the cron in the owner\'s zone, and files runs under a group named after it', async () => {
    await setTimeZone(BUILT_IN_USER_ID, 'Asia/Tokyo', true)
    const r = await routine()
    expect(r).toMatchObject({ name: 'Nightly triage', timeZone: 'Asia/Tokyo', tool: 'claude', paused: false })
    expect(r.model).not.toBe('')
    expect(r.timeoutMinutes).toBeUndefined()
    expect(r.nextRuns).toEqual(nextCronRuns('0 9 * * *', 'Asia/Tokyo', new Date(), 3).map((d) => d.toISOString()))
    const groups = await listWorkspaceGroupRows(PROJ)
    expect(groups.find((g) => g.groupId === r.groupId)?.name).toBe('Nightly triage')

    // A named group, or none, is kept as given.
    expect((await routine({ name: 'Other', group: null })).groupId).toBeUndefined()
    await expect(routine({ cron: 'every day' })).rejects.toThrow(/invalid cron/)
    await expect(routine({ timeZone: 'Mars/Olympus' })).rejects.toThrow(/not an IANA time zone/)
  })
})

describe('updateRoutine', () => {
  it('replaces what it names, re-reading the next tick only when the schedule changes', async () => {
    const r = await routine({ timeout: 30 })
    const before = (await getRoutineRow(r.id))!.nextRunAt
    const renamed = await updateRoutine(local, r.id, { name: 'Renamed', timeout: null })
    expect(renamed).toMatchObject({ name: 'Renamed', groupId: r.groupId })
    expect(renamed.timeoutMinutes).toBeUndefined()
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(before)

    const moved = await updateRoutine(local, r.id, { cron: '30 6 * * 1', timeZone: 'Europe/Paris' })
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(nextCronRuns('30 6 * * 1', 'Europe/Paris', new Date(), 1)[0])
    expect(moved.cron).toBe('30 6 * * 1')
    await expect(updateRoutine(local, r.id, { cron: '61 * * * *' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('never writes back a tick fired, or a pause made, while it ran', async () => {
    const r = await routine({ cron: '*/5 * * * *', timeZone: 'UTC' })
    await due(r.id, latestCronRun('*/5 * * * *', 'UTC', new Date())!)
    await Promise.all([
      updateRoutine(local, r.id, { name: 'renamed' }),
      reconcileRoutines().then(() => startScheduledWorkspaces()),
    ])
    await reconcileRoutines()
    await startScheduledWorkspaces()
    await vi.waitFor(async () => { expect(await runsOf(r.id)).toEqual([]) }, { timeout: 60_000 })
    // One tick, one run.
    expect(launched).toHaveLength(1)
    expect((await getRoutineRow(r.id))!.nextRunAt!.getTime()).toBeGreaterThan(Date.now())

    await Promise.all([setRoutinePaused(local, r.id, true), updateRoutine(local, r.id, { name: 'again' })])
    expect(await getRoutineRow(r.id)).toMatchObject({ paused: true, name: 'again' })
  })
})

describe('setRoutinePaused', () => {
  it('stops ticking while paused and resumes from the next tick, without catching up', async () => {
    const r = await routine()
    const paused = await setRoutinePaused(local, r.id, true)
    expect(paused).toMatchObject({ paused: true, nextRuns: [] })
    expect((await getRoutineRow(r.id))!.nextRunAt).toBeUndefined()
    await reconcileRoutines()
    expect(await runsOf(r.id)).toEqual([])

    await setRoutinePaused(local, r.id, false)
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(nextCronRuns('0 9 * * *', 'UTC', new Date(), 1)[0])
  })
})

describe('reconcileRoutines', () => {
  it('fires a due tick once, as a run the queue launches that stops at the next tick', async () => {
    const r = await routine({ cron: '*/5 * * * *', timeZone: 'UTC' })
    const missed = new Date(Date.now() - 3 * 3_600_000)
    await due(r.id, missed)

    await reconcileRoutines()
    await reconcileRoutines()
    const runs = await runsOf(r.id)
    // Hours of missed ticks collapse into the latest one.
    expect(runs).toHaveLength(1)
    const slot = latestCronRun('*/5 * * * *', 'UTC', new Date())!
    const next = nextCronRuns('*/5 * * * *', 'UTC', slot, 1)[0]
    expect(runs[0]).toMatchObject({ startAt: slot, timeoutMinutes: 5, groupId: r.groupId, prompt: 'triage the issues' })
    expect(runs[0].title).toMatch(/^Nightly triage · /)
    expect((await getRoutineRow(r.id))!).toMatchObject({ nextRunAt: next, lastRunAt: slot })

    await startScheduledWorkspaces()
    await vi.waitFor(async () => { expect(await runsOf(r.id)).toEqual([]) }, { timeout: 60_000 })
    expect(launched).toHaveLength(1)
    expect((await getWorkspaceRow(PROJ, launched[0]))?.deadline).toEqual(next)
    expect((await listRoutines())[0].lastRunAt).toBe(slot.toISOString())
  })

  it('gives each run the gap to the following tick, however irregular, and keeps one failed run', async () => {
    // Friday 2026-10-23 09:00 UTC: a weekday routine's run lasts until Monday.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T09:00:30Z'))
    const r = await routine({ cron: '0 9 * * 1-5', timeZone: 'UTC' })
    await due(r.id, new Date('2026-10-23T09:00:00Z'))
    await reconcileRoutines()
    const [friday] = await runsOf(r.id)
    expect(friday.timeoutMinutes).toBe(3 * 24 * 60)

    // Its launch failed; Monday's tick replaces it rather than piling up,
    // and what was queued after it waits on Monday's run instead.
    await claimQueuedLaunch(friday.id, 'wt-x')
    await failQueuedLaunch(friday.id, 'wt-x', 'no such branch')
    const after = await queueWorkspace(local, PROJ, { parent: friday.id, prompt: 'follow up', branch: 'main' }, 'user')
    expect((await listRoutines())[0].lastError).toBe('no such branch')
    vi.setSystemTime(new Date('2026-10-26T09:00:10Z'))
    await reconcileRoutines()
    const runs = await runsOf(r.id)
    expect(runs.map((e) => e.startAt)).toEqual([new Date('2026-10-26T09:00:00Z')])
    expect(runs[0].timeoutMinutes).toBe(24 * 60)
    expect((await listRoutines())[0].lastError).toBeUndefined()
    const moved = (await listQueuedWorkspaceRows(PROJ)).find((e) => e.id === after.id)
    expect(moved).toMatchObject({ parentQueuedId: runs[0].id })
    expect(moved?.startAt).toBeUndefined()
  })
})

describe('runRoutineNow', () => {
  it('starts a run at once that stops at the next scheduled tick, leaving the schedule alone', async () => {
    const r = await routine({ cron: '0 9 * * *', timeZone: 'UTC' })
    const nextRunAt = (await getRoutineRow(r.id))!.nextRunAt
    const { workspaceId } = await runRoutineNow(local, r.id)
    await vi.waitFor(() => { expect(launched).toEqual([workspaceId]) }, { timeout: 60_000 })
    // Exactly at the tick, however close to it the run starts.
    await vi.waitFor(async () => {
      expect((await getWorkspaceRow(PROJ, workspaceId))?.deadline).toEqual(nextRunAt)
    }, { timeout: 60_000 })
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(nextRunAt)
  })
})

describe('deleteRoutine', () => {
  it('deletes the routine and the runs it queued that never launched', async () => {
    const r = await routine({ cron: '*/5 * * * *' })
    await due(r.id, new Date(Date.now() - 60_000))
    await reconcileRoutines()
    expect(await runsOf(r.id)).toHaveLength(1)
    const [run] = await runsOf(r.id)
    const after = await queueWorkspace(local, PROJ, { parent: run.id, prompt: 'follow up', branch: 'main' }, 'user')
    await deleteRoutine(local, r.id)
    expect(await getRoutineRow(r.id)).toBeUndefined()
    expect((await listQueuedWorkspaceRows(PROJ)).filter((e) => e.prompt === 'triage the issues')).toEqual([])
    // What was queued after the discarded run takes its past start time,
    // but waits for the user rather than launching on the next pass.
    expect((await listQueuedWorkspaceRows(PROJ)).find((e) => e.id === after.id)?.launchError)
      .toMatch(/discarded after its start time/)
    await startScheduledWorkspaces()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(launched).toEqual([])
    await expect(deleteRoutine(local, r.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listRoutines', () => {
  it('lists every routine oldest first, with its next three ticks', async () => {
    const a = await routine()
    const b = await routine({ name: 'Second' })
    const listed = await listRoutines()
    expect(listed.map((x) => x.id)).toEqual([a.id, b.id])
    expect(listed[0].nextRuns).toHaveLength(3)
  })
})

describe('listRoutineRunPage', () => {
  it('pages through a routine\'s runs newest first, with what each became', async () => {
    const r = await routine({ cron: '0 0 1 1 *', timeZone: 'UTC' })
    const { workspaceId } = await runRoutineNow(local, r.id)
    // Launched once its entry records the workspace it became.
    await vi.waitFor(async () => { expect(await runsOf(r.id)).toEqual([]) }, { timeout: 60_000 })
    // A yearly tick months past, so its run is older than the one run now.
    await due(r.id, new Date('2026-01-01T00:00:00Z'))
    await reconcileRoutines()

    const first = await listRoutineRunPage(r.id, { limit: 1 })
    expect(first.runs).toEqual([expect.objectContaining({ state: 'running', workspaceId })])
    expect(first.runs[0].deadline).toBeDefined()
    const rest = await listRoutineRunPage(r.id, { limit: 1, cursor: first.nextCursor! })
    expect(rest.runs).toEqual([expect.objectContaining({ state: 'waiting', startAt: '2026-01-01T00:00:00.000Z' })])
    expect(rest.nextCursor).toBeUndefined()

    // Stopped at its deadline, the routine's next tick, it ended at the next
    // run, whatever timeout the routine is given later; its stopped listing
    // says so too. With a timeout of its own, the stop timed out. One that
    // died after its deadline died.
    const db = await getDb()
    await db.update(workspaces).set({ deadline: new Date(Date.now() - 60_000) }).where(eq(workspaces.workspaceId, workspaceId))
    await recordWorkspaceStopped(PROJ, workspaceId)
    await updateRoutine(local, r.id, { timeout: 30 })
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'ended' })
    expect((await listStoppedWorkspaces({ project: PROJ })).entries[0]).toMatchObject({ timedOut: true, endedAtNextRun: true })
    await clearWorkspaceStopped(PROJ, workspaceId)
    await setWorkspaceDeadline(PROJ, workspaceId, new Date(Date.now() - 60_000))
    await recordWorkspaceStopped(PROJ, workspaceId)
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'timed-out' })
    await clearWorkspaceStopped(PROJ, workspaceId)

    await setWorkspaceDeadline(PROJ, workspaceId, new Date(Date.now() - 60_000))
    await recordWorkspaceStopped(PROJ, workspaceId, { reason: 'oom' })
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'died', deathReason: 'oom' })
    await expect(listRoutineRunPage('nope', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
