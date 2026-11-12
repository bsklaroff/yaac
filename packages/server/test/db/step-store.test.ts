import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, removeWorkspaceRecords } from '#db/workspace-store'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import { insertAddedSteps, listStepsFor, listWorkspaceSteps, resetSteps } from '#db/step-store'
import { storeWorkflow } from '#db/workflow-store'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
let life: Date
/** Each life starts a second after the last, as no two of a workspace share a start. */
let clock: number

type Graph = Record<string, { run: string[]; needs?: string[] }>
let workflowId: string
/** A life starting one workflow named `ci`, or the workflows given. */
const startLife = async (workspaceId: string, steps: Graph, more: Record<string, Graph> = {}): Promise<Date> => {
  const at = new Date(clock += 1000)
  const flows = Object.entries({ ci: steps, ...more }).map(([name, graph]) => ({ id: workflowId, name, steps: graph }))
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: PROJ, workspaceId, at, startSteps: flows })
  return at
}
const change = (name: string, state: 'running' | 'ready' | 'succeeded' | 'failed', exitCode?: number, at = life, workflowName = 'ci'): Promise<void> =>
  applyWorkspaceEvent({ type: 'step-changed', projectId: PROJ, workspaceId: 'w1', life: at, workflowName, name, state, ...(exitCode !== undefined ? { exitCode } : {}) })
/** The steps of one life of `w1`, the first unless `at` names another. */
const rows = async (at = life): Promise<string[]> => (await listWorkspaceSteps('w1'))
  .filter((s) => s.life.getTime() === at.getTime())
  .map((s) => `${s.workflowName}.${s.name}:${s.origin}:${s.state}${s.exitCode !== undefined ? `:${String(s.exitCode)}` : ''}`)

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clock = Date.now()
  for (const workspaceId of ['w1', 'w2']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId })
  workflowId = (await storeWorkflow(PROJ, { steps: {}, secrets: [] })).id
  life = await startLife('w1', { install: { run: ['pnpm install'] }, build: { run: ['pnpm build'], needs: ['install'] } })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('listWorkspaceSteps', () => {
  it('lists every life\'s steps in order, following what is observed of each, stamped', async () => {
    expect(await rows()).toEqual(['ci.install:start:pending', 'ci.build:start:pending'])
    await change('install', 'running')
    await change('install', 'succeeded', 0)
    // A settled step stays settled, and a report from another life changes nothing.
    await change('install', 'failed', 1)
    await change('build', 'running', undefined, new Date(0))
    expect(await rows()).toEqual(['ci.install:start:succeeded:0', 'ci.build:start:pending'])
    const [install] = await listWorkspaceSteps('w1')
    expect(install).toMatchObject({ workflowName: 'ci', workflowId })
    expect(install.startedAt).toBeInstanceOf(Date)
    expect(install.finishedAt).toBeInstanceOf(Date)
    expect(install.life).toEqual(life)
    // The next life starts its own rows and keeps the last one's, an
    // unsettled one interrupted.
    const next = await startLife('w1', { install: { run: ['pnpm install'] } })
    expect(await rows()).toEqual(['ci.install:start:succeeded:0', 'ci.build:start:interrupted'])
    expect(await rows(next)).toEqual(['ci.install:start:pending'])
    // Deleted with its workspace.
    await removeWorkspaceRecords(PROJ, 'w1')
    expect(await listWorkspaceSteps('w1')).toEqual([])
  })
})

describe('insertAddedSteps', () => {
  it('keys steps by workflow and name: two workflows share a step name, and a workflow runs once a life', async () => {
    const both = await startLife('w1', { install: { run: ['pnpm install'] } }, { api: { install: { run: ['pip install'] } } })
    expect(await rows(both)).toEqual(['ci.install:start:pending', 'api.install:start:pending'])
    await change('install', 'running', undefined, both, 'api')
    expect(await rows(both)).toEqual(['ci.install:start:pending', 'api.install:start:running'])

    const other = (await storeWorkflow(PROJ, { steps: { install: { run: ['again'] } }, secrets: [] })).id
    const [added] = await insertAddedSteps(PROJ, 'w1', both, { id: other, name: 'lint' }, { install: { run: ['again'], needs: ['ci.install'] } })
    expect(added).toMatchObject({ workflowName: 'lint', workflowId: other, origin: 'added' })
    await expect(insertAddedSteps(PROJ, 'w1', both, { id: workflowId, name: 'lint' }, { e2e: { run: ['pnpm e2e'] } }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await rows(both)).toEqual(['ci.install:start:pending', 'api.install:start:running', 'lint.install:added:pending'])
    expect((await listWorkspaceSteps('w1')).find((s) => s.workflowName === 'lint')?.workflowId).toBe(other)

    // The next life may run a workflow of that name again; the added step
    // of the life before stays its own, interrupted.
    const next = await startLife('w1', { install: { run: ['pnpm install'] } })
    await insertAddedSteps(PROJ, 'w1', next, { id: workflowId, name: 'lint' }, { install: { run: ['pnpm e2e'] } })
    expect(await rows(both)).toEqual(['ci.install:start:interrupted', 'api.install:start:interrupted', 'lint.install:added:interrupted'])
    expect(await rows(next)).toEqual(['ci.install:start:pending', 'lint.install:added:pending'])

    // An init workflow the life skipped, or one that had no steps then, has
    // not run: adding it takes its row, with the workflow it is now.
    const last = new Date(clock += 1000)
    await applyWorkspaceEvent({
      type: 'workspace-life-started', projectId: PROJ, workspaceId: 'w1', at: last,
      startSteps: [{ id: workflowId, name: 'empty', steps: {} }], skipped: [{ id: workflowId, name: 'api-init' }],
    })
    for (const name of ['empty', 'api-init']) {
      const [step] = await insertAddedSteps(PROJ, 'w1', last, { id: other, name }, { test: { run: ['pytest'] } })
      expect(step).toMatchObject({ workflowName: name, workflowId: other })
      await expect(insertAddedSteps(PROJ, 'w1', last, { id: other, name }, { test: { run: ['pytest'] } }))
        .rejects.toMatchObject({ code: 'CONFLICT' })
    }
    expect((await listWorkspaceSteps('w1')).filter((s) => s.life.getTime() === last.getTime()).map((s) => s.workflowId))
      .toEqual([other, other])
  })
})

describe('resetSteps', () => {
  it('puts steps of the life back to pending, clearing how they ended but keeping when they last started', async () => {
    await change('install', 'running')
    await change('install', 'failed', 2)
    const [before] = await listWorkspaceSteps('w1')
    await resetSteps('w1', life, [{ workflowName: 'ci', name: 'install' }])
    const [install] = await listWorkspaceSteps('w1')
    expect(install).toMatchObject({ state: 'pending', startedAt: before.startedAt })
    expect(install.exitCode).toBeUndefined()
    expect(install.finishedAt).toBeUndefined()
  })
})

describe('listStepsFor', () => {
  it('maps each workspace to its current life\'s steps', async () => {
    await startLife('w2', { lint: { run: ['pnpm lint'] } })
    await startLife('w2', { test: { run: ['pnpm test'] } })
    const map = await listStepsFor(['w1', 'w2', 'w3'])
    expect([...map.keys()].sort()).toEqual(['w1', 'w2'])
    expect(map.get('w1')?.map((s) => s.name)).toEqual(['install', 'build'])
    expect(map.get('w2')).toMatchObject([{ name: 'test', workflowName: 'ci', workflowId }])
    expect(await listStepsFor([])).toEqual(new Map())
  })
})
