import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { namedWorkflows, workflows, workspaces } from '#db/schema'
import { insertAddedSteps } from '#db/step-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import {
  addWorkflowApproval,
  deleteNamedWorkflow,
  deleteProjectWorkflows,
  deleteUnnamedWorkflows,
  findNamedWorkflow,
  getNamedWorkflow,
  getWorkflow,
  insertNamedWorkflow,
  listNamedWorkflows,
  listWorkflowApprovals,
  pointNamedWorkflow,
  recordWorkflowRun,
  storeWorkflow,
  workflowApproved,
  workflowRan,
} from '#db'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const CI = { test: { run: ['pnpm test'] } }
const COMMIT = 'a'.repeat(40)

/**
 * Workflow rows: one per project and content, never changed; names that
 * point at them; and what a named workflow's current one is approved for.
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
  const db = await getDb()
  await db.delete(workspaces)
  await db.delete(namedWorkflows)
  await db.delete(workflows)
})

const none = { steps: CI, secrets: [] }

describe('storeWorkflow', () => {
  it('stores each content once per project, its secrets part of it', async () => {
    const a = await storeWorkflow(PROJ, none)
    expect(a).toMatchObject({ projectId: PROJ, steps: CI, secrets: [] })
    expect((await storeWorkflow(PROJ, none)).id).toBe(a.id)
    expect((await storeWorkflow(PROJ, { steps: CI, secrets: ['KEY'] })).id).not.toBe(a.id)
    expect((await storeWorkflow(OTHER, none)).id).not.toBe(a.id)
  })
})

describe('getWorkflow', () => {
  it('reads one by id', async () => {
    const a = await storeWorkflow(PROJ, none)
    expect(await getWorkflow(a.id)).toEqual(a)
    expect(await getWorkflow('not-a-uuid')).toBeUndefined()
  })
})

describe('insertNamedWorkflow', () => {
  it('names a workflow, refusing a name its project uses', async () => {
    const a = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    await expect(insertNamedWorkflow(PROJ, 'ci', a.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await insertNamedWorkflow(OTHER, 'ci', (await storeWorkflow(OTHER, none)).id)
  })
})

describe('findNamedWorkflow', () => {
  it('finds one in its project, with the workflow it points at', async () => {
    const a = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    expect(await findNamedWorkflow(PROJ, 'ci')).toMatchObject({ name: 'ci', workflow: a })
    expect(await findNamedWorkflow(OTHER, 'ci')).toBeUndefined()
  })
})

describe('getNamedWorkflow', () => {
  it('reads one by id', async () => {
    await insertNamedWorkflow(PROJ, 'ci', (await storeWorkflow(PROJ, none)).id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    expect((await getNamedWorkflow(named!.id))?.name).toBe('ci')
    expect(await getNamedWorkflow('nope')).toBeUndefined()
  })
})

describe('listNamedWorkflows', () => {
  it('lists a project\'s in name order', async () => {
    const a = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'b', a.id)
    await insertNamedWorkflow(PROJ, 'a', a.id)
    expect((await listNamedWorkflows(PROJ)).map((w) => w.name)).toEqual(['a', 'b'])
  })
})

describe('pointNamedWorkflow', () => {
  it('points a name at another workflow, leaving the first stored', async () => {
    const a = await storeWorkflow(PROJ, none)
    const b = await storeWorkflow(PROJ, { steps: {}, secrets: [] })
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await pointNamedWorkflow(named!.id, b.id)
    expect((await findNamedWorkflow(PROJ, 'ci'))?.workflow.id).toBe(b.id)
    expect(await getWorkflow(a.id)).toBeDefined()
  })
})

describe('deleteNamedWorkflow', () => {
  it('drops the name and its approvals, not the workflow', async () => {
    const a = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await addWorkflowApproval(named!.id, COMMIT)
    await deleteNamedWorkflow(named!.id)
    expect(await findNamedWorkflow(PROJ, 'ci')).toBeUndefined()
    expect(await listWorkflowApprovals(named!.id)).toEqual([])
    expect(await getWorkflow(a.id)).toBeDefined()
  })
})

describe('deleteProjectWorkflows', () => {
  it('deletes a project\'s names and workflows only', async () => {
    await insertNamedWorkflow(PROJ, 'ci', (await storeWorkflow(PROJ, none)).id)
    const other = await storeWorkflow(OTHER, none)
    await deleteProjectWorkflows(PROJ)
    expect(await listNamedWorkflows(PROJ)).toEqual([])
    expect(await getWorkflow(other.id)).toBeDefined()
  })
})

describe('deleteUnnamedWorkflows', () => {
  it('deletes the workflows nothing names once an hour old, with their runs', async () => {
    const named = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', named.id)
    const loose = await storeWorkflow(PROJ, { steps: {}, secrets: [] })
    const fresh = await storeWorkflow(PROJ, { steps: { x: { run: ['true'] } }, secrets: [] })
    const added = await storeWorkflow(PROJ, { steps: { y: { run: ['true'] } }, secrets: [] })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'w1' })
    await insertAddedSteps(PROJ, 'w1', new Date(), added.steps, { id: added.id, name: 'gone' })
    await recordWorkflowRun(loose.id, COMMIT)
    const db = await getDb()
    for (const id of [named.id, loose.id, added.id]) {
      await db.update(workflows).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(eq(workflows.id, id))
    }
    expect(await deleteUnnamedWorkflows()).toBe(1)
    expect(await getWorkflow(loose.id)).toBeUndefined()
    expect(await workflowRan(loose.id, COMMIT)).toBe(false)
    expect(await getWorkflow(named.id)).toBeDefined()
    expect(await getWorkflow(fresh.id)).toBeDefined()
    expect(await getWorkflow(added.id)).toBeDefined()
  })
})

describe('addWorkflowApproval', () => {
  it('records a commit or branch once', async () => {
    await insertNamedWorkflow(PROJ, 'ci', (await storeWorkflow(PROJ, none)).id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await addWorkflowApproval(named!.id, COMMIT)
    await addWorkflowApproval(named!.id, COMMIT)
    expect(await listWorkflowApprovals(named!.id)).toEqual([COMMIT])
  })
})

describe('listWorkflowApprovals', () => {
  it('lists commits and branches in order', async () => {
    await insertNamedWorkflow(PROJ, 'ci', (await storeWorkflow(PROJ, none)).id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await addWorkflowApproval(named!.id, 'refs/heads/main')
    await addWorkflowApproval(named!.id, COMMIT)
    expect(await listWorkflowApprovals(named!.id)).toEqual([COMMIT, 'refs/heads/main'])
  })
})

describe('workflowApproved', () => {
  it('answers for a workflow some named workflow points at now', async () => {
    const a = await storeWorkflow(PROJ, none)
    const b = await storeWorkflow(PROJ, { steps: {}, secrets: [] })
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await addWorkflowApproval(named!.id, COMMIT)
    expect(await workflowApproved(a.id, [COMMIT])).toBe(true)
    expect(await workflowApproved(a.id, ['refs/heads/main'])).toBe(false)
    await pointNamedWorkflow(named!.id, b.id)
    expect(await workflowApproved(a.id, [COMMIT])).toBe(false)
    expect(await workflowApproved(b.id, [])).toBe(false)
  })
})

describe('recordWorkflowRun', () => {
  it('records a workflow and commit once', async () => {
    const a = await storeWorkflow(PROJ, none)
    await recordWorkflowRun(a.id, COMMIT)
    await recordWorkflowRun(a.id, COMMIT)
    expect(await workflowRan(a.id, COMMIT)).toBe(true)
  })
})

describe('workflowRan', () => {
  it('answers for that workflow and commit only', async () => {
    const a = await storeWorkflow(PROJ, none)
    await recordWorkflowRun(a.id, COMMIT)
    expect(await workflowRan((await storeWorkflow(PROJ, { steps: {}, secrets: [] })).id, COMMIT)).toBe(false)
    expect(await workflowRan(a.id, 'b'.repeat(40))).toBe(false)
  })
})
