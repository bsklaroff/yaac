import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { workflows } from '#db/schema'
import {
  addWorkflowApproval,
  addWorkflowRevision,
  deleteProjectWorkflows,
  deleteWorkflow,
  findWorkflowByName,
  getWorkflow,
  getWorkflowRevision,
  insertWorkflow,
  listWorkflowApprovals,
  listWorkflowRevisions,
  listWorkflows,
  recordWorkflowRun,
  workflowRan,
} from '#db'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const CI = { test: { run: ['pnpm test'] } }
const COMMIT = 'a'.repeat(40)

/**
 * Workflow rows: a workflow holds its highest-numbered revision, revisions
 * never change, and deleting one takes its revisions, approvals and runs.
 */

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  await (await getDb()).delete(workflows)
})

describe('insertWorkflow', () => {
  it('makes revision 1 current, refusing a name the project uses', async () => {
    const made = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: ['KEY'] })
    expect(made).toMatchObject({ projectId: PROJ, name: 'ci', current: { number: 1, steps: CI, secrets: ['KEY'] } })
    await expect(insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await insertWorkflow(OTHER, 'ci', { steps: CI, secrets: [] })).name).toBe('ci')
  })
})

describe('addWorkflowRevision', () => {
  it('numbers each revision on, and the newest is current', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    const next = await addWorkflowRevision(w.id, { steps: {}, secrets: ['KEY'] })
    expect(next).toMatchObject({ number: 2, steps: {}, secrets: ['KEY'] })
    expect((await getWorkflow(w.id))?.current.id).toBe(next.id)
  })
})

describe('getWorkflow', () => {
  it('reads one by id, with its current revision', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    expect((await getWorkflow(w.id))?.current.number).toBe(1)
    expect(await getWorkflow('not-a-uuid')).toBeUndefined()
  })
})

describe('findWorkflowByName', () => {
  it('finds one within its project only', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    expect((await findWorkflowByName(PROJ, 'ci'))?.id).toBe(w.id)
    expect(await findWorkflowByName(OTHER, 'ci')).toBeUndefined()
  })
})

describe('listWorkflows', () => {
  it('lists a project\'s in name order, each with its current revision', async () => {
    const b = await insertWorkflow(PROJ, 'b', { steps: CI, secrets: [] })
    await insertWorkflow(PROJ, 'a', { steps: CI, secrets: [] })
    await addWorkflowRevision(b.id, { steps: {}, secrets: [] })
    expect((await listWorkflows(PROJ)).map((w) => [w.name, w.current.number])).toEqual([['a', 1], ['b', 2]])
  })
})

describe('getWorkflowRevision', () => {
  it('reads an earlier revision as it was written', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: ['KEY'] })
    await addWorkflowRevision(w.id, { steps: {}, secrets: [] })
    expect(await getWorkflowRevision(w.current.id)).toMatchObject({ number: 1, steps: CI, secrets: ['KEY'] })
  })
})

describe('listWorkflowRevisions', () => {
  it('lists newest first', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await addWorkflowRevision(w.id, { steps: {}, secrets: [] })
    expect((await listWorkflowRevisions(w.id)).map((r) => r.number)).toEqual([2, 1])
  })
})

describe('addWorkflowApproval', () => {
  it('records a commit or branch once', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await addWorkflowApproval(w.id, COMMIT)
    await addWorkflowApproval(w.id, COMMIT)
    expect(await listWorkflowApprovals(w.id)).toEqual([COMMIT])
  })
})

describe('listWorkflowApprovals', () => {
  it('lists commits and branches in order', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await addWorkflowApproval(w.id, 'refs/heads/main')
    await addWorkflowApproval(w.id, COMMIT)
    expect(await listWorkflowApprovals(w.id)).toEqual([COMMIT, 'refs/heads/main'])
  })
})

describe('recordWorkflowRun', () => {
  it('records a revision and commit once', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await recordWorkflowRun(w.current.id, COMMIT)
    await recordWorkflowRun(w.current.id, COMMIT)
    expect(await workflowRan(w.current.id, COMMIT)).toBe(true)
  })
})

describe('workflowRan', () => {
  it('answers for that revision and commit only', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await recordWorkflowRun(w.current.id, COMMIT)
    const next = await addWorkflowRevision(w.id, { steps: CI, secrets: [] })
    expect(await workflowRan(next.id, COMMIT)).toBe(false)
    expect(await workflowRan(w.current.id, 'b'.repeat(40))).toBe(false)
  })
})

describe('deleteWorkflow', () => {
  it('takes its revisions, approvals and runs with it', async () => {
    const w = await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await addWorkflowApproval(w.id, COMMIT)
    await recordWorkflowRun(w.current.id, COMMIT)
    await deleteWorkflow(w.id)
    expect(await getWorkflow(w.id)).toBeUndefined()
    expect(await getWorkflowRevision(w.current.id)).toBeUndefined()
    expect(await listWorkflowApprovals(w.id)).toEqual([])
    expect(await workflowRan(w.current.id, COMMIT)).toBe(false)
  })
})

describe('deleteProjectWorkflows', () => {
  it('deletes one project\'s only', async () => {
    await insertWorkflow(PROJ, 'ci', { steps: CI, secrets: [] })
    await insertWorkflow(OTHER, 'ci', { steps: CI, secrets: [] })
    await deleteProjectWorkflows(PROJ)
    expect(await listWorkflows(PROJ)).toEqual([])
    expect(await listWorkflows(OTHER)).toHaveLength(1)
  })
})
