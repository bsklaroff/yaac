import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { namedWorkflows, workflows, workspaces } from '#db/schema'
import { insertAddedSteps } from '#db/step-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import {
  addApprovals,
  deleteNamedWorkflow,
  deleteProjectWorkflows,
  deleteUnnamedWorkflows,
  findNamedWorkflow,
  getNamedWorkflow,
  getWorkflow,
  insertNamedWorkflow,
  listApprovals,
  listNamedWorkflows,
  setInitWorkflows,
  storeWorkflow,
  updateNamedWorkflow,
} from '#db'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const CI = { test: { run: ['pnpm test'] } }
const COMMIT = 'a'.repeat(40)

/**
 * Workflow rows: one per project and content, never changed; names that
 * point at them; and what each spec is approved for.
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
  it('stores each content once per project, its secrets and repos part of it', async () => {
    const a = await storeWorkflow(PROJ, none)
    expect(a).toMatchObject({ projectId: PROJ, steps: CI, secrets: [], repos: [] })
    expect((await storeWorkflow(PROJ, none)).id).toBe(a.id)
    expect((await storeWorkflow(PROJ, { steps: CI, secrets: ['KEY'] })).id).not.toBe(a.id)
    expect((await storeWorkflow(OTHER, none)).id).not.toBe(a.id)
    // Repos are content, in any order; none hashes as a workflow stored
    // before workflows had repos did.
    const web = await storeWorkflow(PROJ, { ...none, repos: [OTHER, PROJ] })
    expect(web.id).not.toBe(a.id)
    expect(web.repos).toEqual([PROJ, OTHER].sort())
    expect((await storeWorkflow(PROJ, { ...none, repos: [PROJ, OTHER] })).id).toBe(web.id)
    const [row] = await (await getDb()).select({ hash: workflows.hash }).from(workflows).where(eq(workflows.id, a.id))
    expect(row.hash).toBe(createHash('sha256').update(`${JSON.stringify(CI)}\n`).digest('hex'))
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

describe('updateNamedWorkflow', () => {
  it('points a name at another workflow, leaving the first stored, and marks it init or not', async () => {
    const a = await storeWorkflow(PROJ, none)
    const b = await storeWorkflow(PROJ, { steps: {}, secrets: [] })
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    expect(named?.init).toBe(false)
    await updateNamedWorkflow(named!.id, { workflowId: b.id })
    expect((await findNamedWorkflow(PROJ, 'ci'))?.workflow.id).toBe(b.id)
    expect(await getWorkflow(a.id)).toBeDefined()
    await updateNamedWorkflow(named!.id, { init: true })
    expect(await findNamedWorkflow(PROJ, 'ci')).toMatchObject({ init: true, workflow: { id: b.id } })
  })
})

describe('setInitWorkflows', () => {
  it('makes exactly the named ones a project\'s init workflows', async () => {
    const a = await storeWorkflow(PROJ, none)
    for (const name of ['web', 'api', 'ci']) await insertNamedWorkflow(PROJ, name, a.id, name === 'ci')
    await insertNamedWorkflow(OTHER, 'web', a.id, true)
    const id = async (name: string): Promise<string> => (await findNamedWorkflow(PROJ, name))!.id
    await setInitWorkflows(PROJ, [await id('web'), await id('api')])
    const init = async (project: string): Promise<string[]> => (await listNamedWorkflows(project)).filter((w) => w.init).map((w) => w.name)
    expect(await init(PROJ)).toEqual(['api', 'web'])
    await setInitWorkflows(PROJ, [])
    expect(await init(PROJ)).toEqual([])
    expect(await init(OTHER)).toEqual(['web'])
  })
})

describe('deleteNamedWorkflow', () => {
  it('drops the name, not the workflow or its approvals', async () => {
    const a = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', a.id)
    const named = await findNamedWorkflow(PROJ, 'ci')
    await addApprovals({ spec: a.id, workflowId: a.id }, [COMMIT])
    await deleteNamedWorkflow(named!.id)
    expect(await findNamedWorkflow(PROJ, 'ci')).toBeUndefined()
    expect(await getWorkflow(a.id)).toBeDefined()
    expect(await listApprovals(a.id)).toEqual([COMMIT])
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
  it('deletes the workflows nothing names once an hour old', async () => {
    const named = await storeWorkflow(PROJ, none)
    await insertNamedWorkflow(PROJ, 'ci', named.id)
    const loose = await storeWorkflow(PROJ, { steps: {}, secrets: [] })
    const fresh = await storeWorkflow(PROJ, { steps: { x: { run: ['true'] } }, secrets: [] })
    const added = await storeWorkflow(PROJ, { steps: { y: { run: ['true'] } }, secrets: [] })
    const life = new Date()
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'w1', at: life })
    await insertAddedSteps(PROJ, 'w1', life, { id: added.id, name: 'gone' }, added.steps)
    const db = await getDb()
    for (const id of [named.id, loose.id, added.id]) {
      await db.update(workflows).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(eq(workflows.id, id))
    }
    expect(await deleteUnnamedWorkflows()).toBe(1)
    expect(await getWorkflow(loose.id)).toBeUndefined()
    expect(await getWorkflow(named.id)).toBeDefined()
    expect(await getWorkflow(fresh.id)).toBeDefined()
    expect(await getWorkflow(added.id)).toBeDefined()
  })
})

describe('addApprovals', () => {
  it('records each ref once per spec, and they go with their workflow or site', async () => {
    const a = await storeWorkflow(PROJ, none)
    const spec = { spec: a.id, workflowId: a.id }
    await addApprovals(spec, [COMMIT, COMMIT])
    await addApprovals(spec, [])
    await addApprovals({ spec: `site:${a.id}`, workflowId: a.id }, [COMMIT])
    expect(await listApprovals(a.id)).toEqual([COMMIT])
    await (await getDb()).delete(workflows).where(eq(workflows.id, a.id))
    expect(await listApprovals(a.id)).toEqual([])
    expect(await listApprovals(`site:${a.id}`)).toEqual([])
  })
})

describe('listApprovals', () => {
  it('lists a spec\'s commits and branches in order', async () => {
    const a = await storeWorkflow(PROJ, none)
    await addApprovals({ spec: a.id, workflowId: a.id }, [`${PROJ}:refs/heads/main`, COMMIT])
    expect(await listApprovals(a.id)).toEqual([`${PROJ}:refs/heads/main`, COMMIT])
    expect(await listApprovals('other')).toEqual([])
  })
})
