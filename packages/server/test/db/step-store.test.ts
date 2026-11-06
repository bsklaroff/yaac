import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, removeWorkspaceRecords } from '#db/workspace-store'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import { insertAddedSteps, listStepsFor, listWorkspaceSteps, resetSteps } from '#db/step-store'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
let life: Date

const startLife = async (workspaceId: string, startSteps: Record<string, { run: string[]; needs?: string[] }>): Promise<Date> => {
  const at = new Date(Date.now() + Math.random())
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: PROJ, workspaceId, at, startSteps })
  return at
}
const change = (name: string, state: 'running' | 'ready' | 'succeeded' | 'failed', exitCode?: number, at = life): Promise<void> =>
  applyWorkspaceEvent({ type: 'step-changed', projectId: PROJ, workspaceId: 'w1', life: at, name, state, ...(exitCode !== undefined ? { exitCode } : {}) })
const rows = async (): Promise<string[]> =>
  (await listWorkspaceSteps('w1')).map((s) => `${s.name}:${s.origin}:${s.state}${s.exitCode !== undefined ? `:${String(s.exitCode)}` : ''}`)

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  for (const workspaceId of ['w1', 'w2']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId })
  life = await startLife('w1', { install: { run: ['pnpm install'] }, build: { run: ['pnpm build'], needs: ['install'] } })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('listWorkspaceSteps', () => {
  it('lists a life\'s start steps in order, following what is observed of each, stamped', async () => {
    expect(await rows()).toEqual(['install:start:pending', 'build:start:pending'])
    await change('install', 'running')
    await change('install', 'succeeded', 0)
    // A settled step stays settled, and a report from another life changes nothing.
    await change('install', 'failed', 1)
    await change('build', 'running', undefined, new Date(0))
    expect(await rows()).toEqual(['install:start:succeeded:0', 'build:start:pending'])
    const [install] = await listWorkspaceSteps('w1')
    expect(install.startedAt).toBeInstanceOf(Date)
    expect(install.finishedAt).toBeInstanceOf(Date)
    expect(install.life).toEqual(life)
    // Deleted with its workspace.
    await removeWorkspaceRecords(PROJ, 'w1')
    expect(await listWorkspaceSteps('w1')).toEqual([])
  })
})

describe('insertAddedSteps', () => {
  it('adds steps after the others, refusing a name this life holds, and a new life interrupts them', async () => {
    await insertAddedSteps(PROJ, 'w1', life, { e2e: { run: ['pnpm e2e'], needs: ['build'] } })
    await expect(insertAddedSteps(PROJ, 'w1', life, { install: { run: ['again'] } })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await rows()).toEqual(['install:start:pending', 'build:start:pending', 'e2e:added:pending'])

    const next = await startLife('w1', { install: { run: ['pnpm install'] } })
    expect(await rows()).toEqual(['e2e:added:interrupted', 'install:start:pending'])
    // An earlier life's added step of a name is replaced by a new one.
    await insertAddedSteps(PROJ, 'w1', next, { e2e: { run: ['pnpm e2e'] } })
    expect(await rows()).toEqual(['install:start:pending', 'e2e:added:pending'])
  })
})

describe('resetSteps', () => {
  it('puts steps of the life back to pending, clearing how they ended but keeping when they last started', async () => {
    await change('install', 'running')
    await change('install', 'failed', 2)
    const [before] = await listWorkspaceSteps('w1')
    await resetSteps('w1', life, ['install'])
    const [install] = await listWorkspaceSteps('w1')
    expect(install).toMatchObject({ state: 'pending', startedAt: before.startedAt })
    expect(install.exitCode).toBeUndefined()
    expect(install.finishedAt).toBeUndefined()
  })
})

describe('listStepsFor', () => {
  it('maps each workspace to its steps', async () => {
    await startLife('w2', { lint: { run: ['pnpm lint'] } })
    const map = await listStepsFor(['w1', 'w2', 'w3'])
    expect([...map.keys()].sort()).toEqual(['w1', 'w2'])
    expect(map.get('w2')?.map((s) => s.name)).toEqual(['lint'])
    expect(await listStepsFor([])).toEqual(new Map())
  })
})
