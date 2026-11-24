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
  runQueuedWorkspace,
  runRoutineNow,
  setRoutinePaused,
  updateRoutine,
} from '#domain/workspaces'
import { createWorkflow, editWorkflow, listProjectWorkflows, resolveWorkflow, setRunSecret } from '#domain/projects'
import type { WorkspaceSpec } from '#drivers/contract'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { listQueuedWorkspaceRows, claimQueuedLaunch, failQueuedLaunch } from '#db/queued-workspace-store'
import { getRoutineRow, setRoutinePaused as setRoutinePausedRow } from '#db/routine-store'
import { BUILT_IN_USER_ID, getWorkspaceRow, insertRepo, linkProjectRepo, listWorkspaceGroupRows, setTimeZone } from '#db'
import fs from 'node:fs/promises'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import { recordWorkspaceLife, recordWorkspaceStopped, setWorkspaceDeadline } from '#db/workspace-store'
import { closeDb, getDb } from '#db/client'
import { workspaceLives } from '#db/schema'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { latestCronRun, nextCronRuns } from '@yaac/shared/schedule'
import { workspaceDelegate } from '#test/support/delegate'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const IMAGE = 'b6a1f6a4-5d43-4e0b-9a59-6c2f0b8f3e11'

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

/** A non-interactive routine running the `relay` workflow, which gives
 *  its runs P8_KEY. */
/** A second repo of the project, in the folder `docs`. */
const DOCS = '0a0a0a0a-0000-4000-8000-0000000000dd'

async function relayRoutine(principal: Parameters<typeof createRoutine>[0], over: Partial<Parameters<typeof createRoutine>[2]> = {}) {
  return await createRoutine(principal, PROJ, {
    name: 'Relay', cron: '*/5 * * * *', timeZone: 'UTC', nonInteractive: true, workflow: 'relay', ...over,
  })
}

/** Make a routine's next tick already due, as the clock moving past it
 *  would. */
async function due(id: string, at: Date): Promise<void> {
  await setRoutinePausedRow(id, false, at)
}

/** The routine's queued runs, launched ones excluded. */
const runsOf = async (id: string) => (await listQueuedWorkspaceRows(PROJ)).filter((e) => e.routineId === id)

describe('createRoutine', () => {
  it('resolves its settings, reads the cron in the owner\'s zone, and files runs under a group of its own', async () => {
    await setTimeZone(BUILT_IN_USER_ID, 'Asia/Tokyo', true)
    const r = await routine()
    expect(r).toMatchObject({ name: 'Nightly triage', timeZone: 'Asia/Tokyo', tool: 'claude', paused: false })
    expect(r.model).not.toBe('')
    expect(r.timeoutMinutes).toBeUndefined()
    expect(r.nextRuns).toEqual(nextCronRuns('0 9 * * *', 'Asia/Tokyo', new Date(), 3).map((d) => d.toISOString()))
    const groups = await listWorkspaceGroupRows(PROJ)
    expect(groups.find((g) => g.groupId === r.groupId)).toMatchObject({ name: 'Nightly triage', ownerKind: 'routine', ownerId: r.id })
    // A second of the same name gets its own, rather than joining the first's.
    const twin = await routine()
    expect(twin.groupId).not.toBe(r.groupId)

    // A named group, or none, is kept as given.
    expect((await routine({ name: 'Other', group: null })).groupId).toBeUndefined()
    await expect(routine({ cron: 'every day' })).rejects.toThrow(/invalid cron/)
    await expect(routine({ timeZone: 'Mars/Olympus' })).rejects.toThrow(/not an IANA time zone/)
  })
})

describe('createRoutine for a delegate', () => {
  it("holds a delegate's routine, its resume and its run now to its ceiling, taking its ceiling where it names none", async () => {
    const agent = workspaceDelegate(BUILT_IN_USER_ID, 'w1', { projectId: PROJ, ceiling: 'accept-edits' })
    expect((await createRoutine(agent, PROJ, { name: 'Mine', cron: '0 9 * * *', prompt: 'p', tool: 'claude' })).permissionMode)
      .toBe('accept-edits')
    await expect(createRoutine(agent, PROJ, { name: 'Loose', cron: '0 9 * * *', prompt: 'p', tool: 'claude', permissionMode: 'bypass' }))
      .rejects.toThrow(/more permissive than the caller's ceiling \('accept-edits'\)/)
    const loose = await routine({ permissionMode: 'bypass' })
    await setRoutinePaused(local, loose.id, true)
    for (const act of [() => setRoutinePaused(agent, loose.id, false), () => runRoutineNow(agent, loose.id)]) {
      await expect(act()).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining(`routine ${loose.id.slice(0, 8)}`) as string })
    }
    await expect(updateRoutine(agent, loose.id, { name: 'Renamed' })).rejects.toThrow(/more permissive than the caller's ceiling/)
    expect((await updateRoutine(agent, loose.id, { permissionMode: 'plan' })).permissionMode).toBe('plan')
    await expect(setRoutinePaused(agent, loose.id, false)).resolves.toMatchObject({ paused: false })
  })
})

describe('createRoutine on a workflow', () => {
  it('approves the commit or branch it runs on when a person saves it, and nothing when an agent does', async () => {
    const agent = workspaceDelegate(BUILT_IN_USER_ID, 'w1')
    await setRunSecret(local, PROJ, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, PROJ, { name: 'relay', steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
    // An agent may save one, whose runs then wait for a person's approval.
    expect((await relayRoutine(agent, { name: 'Agents', branch: 'main' })).workflow).toBe('relay')
    expect((await listProjectWorkflows(PROJ))[0].approvedBranches).toEqual([])
    const r = await relayRoutine(local, { branch: 'main' })
    expect(r).toMatchObject({ workflow: 'relay', selection: { repos: [{ repo: PROJ, branch: 'main' }], nested: false, cwd: PROJ } })
    expect((await listProjectWorkflows(PROJ))[0].approvedBranches).toEqual(['main'])
    expect((await relayRoutine(agent, { name: 'Again', branch: 'main' })).workflow).toBe('relay')
    // One that starts with no repos runs only steps a person wrote.
    expect((await relayRoutine(local, { name: 'Bare', repos: [] })).selection.repos).toEqual([])
    await expect(relayRoutine(local, { workflow: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Saved with two repos, a person approves the start of each.
    await fs.cp(repoDir(PROJ), repoDir(DOCS), { recursive: true })
    await insertRepo({ id: DOCS, owner: BUILT_IN_USER_ID, remoteUrl: 'https://example.com/docs' })
    await linkProjectRepo(PROJ, DOCS, 'docs')
    const commit = (await git(repoDir(PROJ), ['rev-parse', 'origin/main'])).trim()
    await relayRoutine(local, { name: 'Two', repos: [{ repo: PROJ, branch: 'dev' }, { repo: 'docs', commit }] })
    expect((await listProjectWorkflows(PROJ))[0]).toMatchObject({ approvedCommits: [commit], approvedBranches: expect.arrayContaining(['demo@dev']) as unknown })
    // An interactive routine's runs get no secrets, so saving one approves
    // nothing, and an edit leaving the workflow and start alone approves
    // nothing either.
    const before = (await listProjectWorkflows(PROJ))[0]
    await relayRoutine(local, { name: 'Look', nonInteractive: false, prompt: 'look', repos: [{ repo: PROJ, branch: 'other' }] })
    await updateRoutine(local, r.id, { name: 'Relay renamed' })
    expect((await listProjectWorkflows(PROJ))[0]).toMatchObject({
      approvedCommits: before.approvedCommits, approvedBranches: before.approvedBranches,
    })
    // A routine whose workflow runs in a repo its runs lack is refused at save.
    await createWorkflow(local, PROJ, { name: 'docs-ci', steps: { t: { run: 'true' } }, repos: ['docs'] })
    await expect(relayRoutine(local, { name: 'Lacks', workflow: 'docs-ci', repos: [{ repo: PROJ, branch: 'main' }] }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: /runs in docs/ })
  })
})

describe('updateRoutine', () => {
  it('replaces what it names, re-reading the next tick only when the schedule changes', async () => {
    const r = await routine({ timeout: 30, imageId: IMAGE })
    const before = (await getRoutineRow(r.id))!.nextRunAt
    const renamed = await updateRoutine(local, r.id, { name: 'Renamed', timeout: null })
    expect(renamed).toMatchObject({ name: 'Renamed', groupId: r.groupId, imageId: IMAGE })
    expect(renamed.timeoutMinutes).toBeUndefined()
    expect(await updateRoutine(local, r.id, { imageId: null })).not.toHaveProperty('imageId')
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(before)

    const moved = await updateRoutine(local, r.id, { cron: '30 6 * * 1', timeZone: 'Europe/Paris' })
    expect((await getRoutineRow(r.id))!.nextRunAt).toEqual(nextCronRuns('30 6 * * 1', 'Europe/Paris', new Date(), 1)[0])
    expect(moved.cron).toBe('30 6 * * 1')
    await expect(updateRoutine(local, r.id, { cron: '61 * * * *' })).rejects.toMatchObject({ code: 'VALIDATION' })

    // What its runs start with is kept where an edit names nothing else; a
    // branch on its own restarts its one repo, and its runs copy the result.
    const dev = { repos: [{ repo: PROJ, branch: 'dev' }], nested: false, cwd: PROJ }
    expect((await updateRoutine(local, r.id, { branch: 'dev' })).selection).toEqual(dev)
    expect((await updateRoutine(local, r.id, { name: 'Again' })).selection).toEqual(dev)
    expect((await updateRoutine(local, r.id, { repos: [] })).selection).toEqual({ repos: [], nested: false, cwd: '.' })
  })

  it('keeps its named workflow until an edit names another, or none for the init steps', async () => {
    await createWorkflow(local, PROJ, { name: 'ci', steps: { t: { run: 'true' } } })
    await createWorkflow(local, PROJ, { name: 'lint', steps: { l: { run: 'true' } } })
    const r = await routine({ prompt: undefined, nonInteractive: true, workflow: 'ci' })
    expect(r.workflow).toBe('ci')
    expect((await updateRoutine(local, r.id, { name: 'Renamed' })).workflow).toBe('ci')
    expect((await updateRoutine(local, r.id, { workflow: 'lint' })).workflow).toBe('lint')
    const onInit = await updateRoutine(local, r.id, { workflow: null, nonInteractive: false, prompt: 'triage' })
    expect(onInit.workflow).toBeUndefined()
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

  it('starts a run with its named workflow as it is at launch, and its secrets', async () => {
    const specs: WorkspaceSpec[] = []
    installFakeWorkspaceDriver({
      launch: (spec) => {
        specs.push(spec)
        return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
      },
    })
    await setRunSecret(local, PROJ, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, PROJ, { name: 'relay', steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
    const r = await relayRoutine(local, { branch: 'main' })
    await due(r.id, latestCronRun('*/5 * * * *', 'UTC', new Date())!)
    await reconcileRoutines()
    // Edits made while the run waits are what it starts with. That content
    // is new, which nothing approved, so the run waits for a person, who is
    // shown it and approves exactly that.
    await editWorkflow(local, PROJ, 'relay', { steps: { u: { run: 'true' } }, secrets: ['P8_KEY'] })
    await startScheduledWorkspaces()
    const [run] = await runsOf(r.id)
    const request = await vi.waitFor(async () => {
      const row = (await listQueuedWorkspaceRows(PROJ)).find((e) => e.id === run.id)
      expect(row?.approvalRequest).toBeDefined()
      return row!.approvalRequest!
    }, { timeout: 60_000 })
    expect(request.workflowId).toBe((await resolveWorkflow(PROJ, 'relay')).workflow.id)
    expect(specs).toEqual([])
    await runQueuedWorkspace(local, run.id, { workflowId: request.workflowId, commits: Object.values(request.commits).map((commit) => ({ dir: '', commit })) })
    await vi.waitFor(() => { expect(specs).toHaveLength(1) }, { timeout: 60_000 })
    expect(specs[0].runSecrets).toEqual(['P8_KEY'])
    const row = await getWorkspaceRow(PROJ, specs[0].workspaceId)
    expect(row?.workflowId).toBe((await resolveWorkflow(PROJ, 'relay')).workflow.id)
    expect(row?.workflowName).toBe('relay')
  })

  it('gives each run the gap to the following tick, however irregular, and keeps one failed run', async () => {
    // Friday 2026-10-23 09:00 UTC: a weekday routine's run lasts until Monday.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T09:00:30Z'))
    const r = await routine({ cron: '0 9 * * 1-5', timeZone: 'UTC', imageId: IMAGE })
    await due(r.id, new Date('2026-10-23T09:00:00Z'))
    await reconcileRoutines()
    const [friday] = await runsOf(r.id)
    // Each run launches the routine's image.
    expect(friday).toMatchObject({ timeoutMinutes: 3 * 24 * 60, imageId: IMAGE })

    // Its launch failed; Monday's tick replaces it rather than piling up,
    // and what was queued after it waits on Monday's run instead.
    await claimQueuedLaunch(friday.id, 'wt-x')
    await failQueuedLaunch(friday.id, 'wt-x', 'no such branch')
    const after = await queueWorkspace(local, PROJ, { parent: friday.id, prompt: 'follow up', branch: 'main' })
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
    const after = await queueWorkspace(local, PROJ, { parent: run.id, prompt: 'follow up', branch: 'main' })
    await deleteRoutine(local, r.id)
    expect(await getRoutineRow(r.id)).toBeUndefined()
    // Its group stays, an ordinary one now, holding its runs.
    expect((await listWorkspaceGroupRows(PROJ)).find((g) => g.groupId === r.groupId)).toMatchObject({ ownerKind: null, ownerId: null })
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
    // One whose launch waits for a person's approval says so.
    const [waiting] = await runsOf(r.id)
    await claimQueuedLaunch(waiting.id, 'wt-approval')
    await failQueuedLaunch(waiting.id, 'wt-approval', 'no person has approved this', { workflowId: PROJ, commits: {} })
    expect((await listRoutineRunPage(r.id, { limit: 1, cursor: first.nextCursor! })).runs[0]).toMatchObject({ state: 'awaiting-approval' })

    // Stopped at its deadline, the routine's next tick, it ended at the next
    // run, whatever timeout the routine is given later; its stopped listing
    // says so too. With a timeout of its own, the stop timed out. One that
    // died after its deadline died.
    const db = await getDb()
    await db.update(workspaceLives).set({ deadline: new Date(Date.now() - 60_000) }).where(eq(workspaceLives.workspaceId, workspaceId))
    await recordWorkspaceStopped(PROJ, workspaceId)
    await updateRoutine(local, r.id, { timeout: 30 })
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'ended' })
    expect((await listStoppedWorkspaces({ project: PROJ })).entries[0]).toMatchObject({ timedOut: true, endedAtNextRun: true })
    await recordWorkspaceLife(PROJ, workspaceId, { at: new Date(Date.now() + 1000) })
    await setWorkspaceDeadline(PROJ, workspaceId, new Date(Date.now() - 60_000))
    await recordWorkspaceStopped(PROJ, workspaceId)
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'timed-out' })
    await recordWorkspaceLife(PROJ, workspaceId, { at: new Date(Date.now() + 2000) })

    await setWorkspaceDeadline(PROJ, workspaceId, new Date(Date.now() - 60_000))
    await recordWorkspaceStopped(PROJ, workspaceId, { reason: 'oom' })
    expect((await listRoutineRunPage(r.id, { limit: 1 })).runs[0]).toMatchObject({ state: 'died', deathReason: 'oom' })
    await expect(listRoutineRunPage('nope', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
