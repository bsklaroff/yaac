import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  deleteProjectIcon,
  deleteProjectRow,
  getProjectIcon,
  getProjectRow,
  listProjectIconHashes,
  listProjectRows,
  recordProject,
  recordProjectCreate,
  setProjectConfig,
  setProjectKeptIgnoredPaths,
  setProjectWorkspaceRetention,
  setProjectEgressAllowlist,
  setProjectScratchDirs,
  setProjectIcon,
  setProjectInit,
  setProjectOrder,
} from '#db/project-store'
import { insertRepo, linkProjectRepo, listProjectRepos } from '#db/repo-store'
import { findNamedWorkflow, insertNamedWorkflow, storeWorkflow } from '#db/workflow-store'
import { BUILT_IN_USER_ID, seeTailnetUser } from '#db/user-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'

const APP = '0a0a0a0a-0000-4000-8000-000000000001'
const P = '0a0a0a0a-0000-4000-8000-000000000002'
const Q = '0a0a0a0a-0000-4000-8000-000000000003'

describe('recordProject', () => {
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

  it('records a project and reads it back', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

    expect(await getProjectRow(APP)).toEqual({
      id: APP,
      name: 'app',
      addedAt: '2026-01-01',
      owner: BUILT_IN_USER_ID,
      createDefaults: {},
      repos: [],
      egressAllowlist: { hosts: [], defaults: true },
      keptIgnoredPaths: [],
      scratchDirs: { dirs: [{ path: 'node_modules' }, { path: 'target' }], ignoredTracked: [] },
      portForwards: [],
      cacheVolumes: {},
      nestedContainers: false,
      npmCache: true,
    })
  })

  // The project list is a snapshot input and this is its only INSERT, so
  // this is where a new project notifies.
  it('pushes a fresh snapshot', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(pushes).toBe(1)
  })
})

describe('deleteProjectRow', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('removes the row, its create memory and its links, and pushes a fresh snapshot', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProjectCreate(APP, 'codex', { model: 'gpt-6-sol' })
    await insertRepo({ id: P, owner: BUILT_IN_USER_ID, remoteUrl: 'https://x/app.git' })
    await linkProjectRepo(APP, P, 'app')
    _resetWorkspaceListChangedForTests()
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    await deleteProjectRow(APP)
    expect(await getProjectRow(APP)).toBeUndefined()
    expect(pushes).toBe(1)
    // Its links go with it; the repo stays its owner's.
    expect(await listProjectRepos(APP)).toEqual([])
    // A project re-added under the same id starts with no memory rather
    // than inheriting the removed one's.
    await recordProject({ id: APP, name: 'app', addedAt: '2026-02-01' }, BUILT_IN_USER_ID)
    expect(await getProjectRow(APP)).toMatchObject({ createDefaults: {} })
    expect((await getProjectRow(APP))?.lastTool).toBeUndefined()
  })
})

describe('listProjectRows', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('is empty on a fresh data dir, and lists what was recorded', async () => {
    expect(await listProjectRows()).toEqual([])
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(await listProjectRows()).toEqual([
      {
        id: APP,
        name: 'app',
        addedAt: '2026-01-01',
        owner: BUILT_IN_USER_ID,
        createDefaults: {},
        repos: [],
        egressAllowlist: { hosts: [], defaults: true },
        keptIgnoredPaths: [],
        scratchDirs: { dirs: [{ path: 'node_modules' }, { path: 'target' }], ignoredTracked: [] },
        portForwards: [],
        cacheVolumes: {},
        nestedContainers: false,
        npmCache: true,
      },
    ])
  })

  it('lists projects nobody has placed by when they were added', async () => {
    await recordProject({ id: P, name: 'p', addedAt: '2026-01-02' }, BUILT_IN_USER_ID)
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    // An update rewrites the row, which must not move it.
    await setProjectKeptIgnoredPaths(APP, ['.env'])
    expect((await listProjectRows()).map((r) => r.id)).toEqual([APP, P])
  })

  it('carries each project\'s links, in the order it lists them, on both reads', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: P, name: 'p', addedAt: '2026-01-02' }, BUILT_IN_USER_ID)
    for (const [id, url] of [[P, 'https://x/api.git'], [Q, 'https://x/web.git']]) {
      await insertRepo({ id, owner: BUILT_IN_USER_ID, remoteUrl: url })
    }
    await linkProjectRepo(APP, P, 'api')
    await linkProjectRepo(APP, Q, 'web')

    const [app, p] = await listProjectRows()
    expect(app.repos.map((l) => [l.dir, l.repo.remoteUrl])).toEqual([['api', 'https://x/api.git'], ['web', 'https://x/web.git']])
    expect(p.repos).toEqual([])
    expect((await getProjectRow(APP))?.repos).toEqual(app.repos)
  })
})

describe('setProjectOrder', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('places the owner\'s listed projects, puts the rest last, and ignores other ids', async () => {
    const R = '0a0a0a0a-0000-4000-8000-000000000004'
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    for (const [id, addedAt, owner] of [[APP, '2026-01-01', BUILT_IN_USER_ID], [P, '2026-01-02', BUILT_IN_USER_ID], [Q, '2026-01-03', BUILT_IN_USER_ID], [R, '2026-01-04', bob]]) {
      await recordProject({ id, name: id, addedAt }, owner)
    }
    const listed = async (): Promise<string[]> => (await listProjectRows()).map((r) => r.id)

    // R is bob's and the last id is no project: both are ignored. APP is
    // left out, so it follows the placed ones.
    await setProjectOrder(BUILT_IN_USER_ID, [R, Q, P, randomUUID()])
    expect(await listed()).toEqual([Q, P, APP, R])
    await setProjectOrder(bob, [R])
    expect(await listed()).toEqual([R, Q, P, APP])

    // An empty list unplaces all of the owner's projects, and no one else's.
    await setProjectOrder(BUILT_IN_USER_ID, [])
    expect(await listed()).toEqual([R, APP, P, Q])
  })
})

describe('setProjectScratchDirs', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('replaces whichever part it is given, answering the settings as stored, or undefined for no such project', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    const dirs = [{ path: 'node_modules' }, { path: 'target' }]
    expect(await setProjectScratchDirs(APP, { ignoredTracked: ['target'] }))
      .toEqual({ dirs, ignoredTracked: ['target'] })
    expect(await setProjectScratchDirs(APP, { dirs: [{ path: 'node_modules', sizeGiB: 4 }] }))
      .toEqual({ dirs: [{ path: 'node_modules', sizeGiB: 4 }], ignoredTracked: ['target'] })
    expect((await getProjectRow(APP))?.scratchDirs)
      .toEqual({ dirs: [{ path: 'node_modules', sizeGiB: 4 }], ignoredTracked: ['target'] })
    expect(await setProjectScratchDirs(randomUUID(), { dirs: [] })).toBeUndefined()
  })
})

describe('recordProjectCreate', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorkspaceListChangedForTests()
  })
  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('remembers the agent and what it was created with, per agent and per project', async () => {
    await recordProject({ id: P, name: 'p', addedAt: 'now' }, BUILT_IN_USER_ID)
    await recordProject({ id: Q, name: 'q', addedAt: 'now' }, BUILT_IN_USER_ID)
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    await recordProjectCreate(P, 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' })
    await recordProjectCreate(P, 'codex', { model: 'gpt-6-sol' })
    expect(pushes).toBe(2)

    expect(await getProjectRow(P)).toMatchObject({
      lastTool: 'codex',
      createDefaults: {
        claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' },
        codex: { model: 'gpt-6-sol' },
      },
    })
    // Another project is untouched: the memory is per project.
    const q = await getProjectRow(Q)
    expect(q?.lastTool).toBeUndefined()
    expect(q?.createDefaults).toEqual({})
    // And the list read carries the same memory as the point read.
    expect((await listProjectRows()).find((r) => r.id === P)?.createDefaults)
      .toEqual((await getProjectRow(P))?.createDefaults)
  })

  // A create that took the resolved default for a field names nothing for
  // it, and must not overwrite what a person picked — while the agent itself
  // is always the one this project was last created with.
  it('writes only the fields it is given', async () => {
    await recordProject({ id: P, name: 'p', addedAt: 'now' }, BUILT_IN_USER_ID)
    await recordProjectCreate(P, 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan' })
    await recordProjectCreate(P, 'claude', { mode: 'acp' })
    await recordProjectCreate(P, 'claude', {})

    expect(await getProjectRow(P)).toMatchObject({
      lastTool: 'claude',
      createDefaults: { claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' } },
    })
  })

  // What a create started with is remembered whole: the repos it included
  // (and so the ones it left out), the branch it named for each, its
  // layout and its cwd. A create that says nothing of them leaves all be.
  it('remembers which repos a create started with, each one\'s branch, the layout and the cwd', async () => {
    await recordProject({ id: P, name: 'p', addedAt: 'now' }, BUILT_IN_USER_ID)
    const [api, web, docs] = [APP, Q, '0a0a0a0a-0000-4000-8000-000000000005']
    for (const [id, dir] of [[api, 'api'], [web, 'web'], [docs, 'docs']]) {
      await insertRepo({ id, owner: BUILT_IN_USER_ID, remoteUrl: `https://x/${dir}.git` })
      await linkProjectRepo(P, id, dir)
    }
    const remembered = async (): Promise<Array<[string, boolean, string | undefined]>> =>
      (await listProjectRepos(P)).map((l) => [l.dir, l.lastIncluded, l.lastBranch])
    expect(await remembered()).toEqual([['api', true, undefined], ['web', true, undefined], ['docs', true, undefined]])

    await recordProjectCreate(P, 'claude', {}, { repos: [{ repoId: api, branch: 'develop' }, { repoId: web }], nested: true, cwd: api })
    expect(await remembered()).toEqual([['api', true, 'develop'], ['web', true, undefined], ['docs', false, undefined]])
    expect(await getProjectRow(P)).toMatchObject({ lastNested: true, lastCwd: api })

    // A branch is kept for a repo a later create leaves out or names none for.
    await recordProjectCreate(P, 'claude', {}, { repos: [], nested: false, cwd: '.' })
    expect(await remembered()).toEqual([['api', false, 'develop'], ['web', false, undefined], ['docs', false, undefined]])
    expect(await getProjectRow(P)).toMatchObject({ lastNested: false, lastCwd: '.' })

    await recordProjectCreate(P, 'claude', { mode: 'acp' })
    expect(await getProjectRow(P)).toMatchObject({ lastNested: false, lastCwd: '.' })
  })
})

describe('setProjectEgressAllowlist', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('replaces the allowlist, and reports an unknown projectId', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

    expect(await setProjectEgressAllowlist(APP, { hosts: ['a.com'], defaults: true })).toBe(true)
    expect(await setProjectEgressAllowlist(APP, { hosts: ['b.com'], defaults: false })).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ egressAllowlist: { hosts: ['b.com'], defaults: false } })
    expect(await setProjectEgressAllowlist('0a0a0a0a-0000-4000-8000-0000000000ff', { hosts: [], defaults: true }))
      .toBe(false)
  })
})

describe('setProjectWorkspaceRetention', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('sets and clears the retention, and reports an unknown projectId', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect((await getProjectRow(APP))?.stoppedWorkspaceRetentionDays).toBeUndefined()

    expect(await setProjectWorkspaceRetention(APP, 30)).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ stoppedWorkspaceRetentionDays: 30 })
    expect(await setProjectWorkspaceRetention(APP, null)).toBe(true)
    expect((await getProjectRow(APP))?.stoppedWorkspaceRetentionDays).toBeUndefined()
    expect(await setProjectWorkspaceRetention('0a0a0a0a-0000-4000-8000-0000000000ff', 30)).toBe(false)
  })
})

describe('setProjectKeptIgnoredPaths', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('replaces the kept paths, and reports an unknown projectId', async () => {
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(await setProjectKeptIgnoredPaths(APP, ['.env', 'data/dev.db'])).toBe(true)
    expect((await getProjectRow(APP))?.keptIgnoredPaths).toEqual(['.env', 'data/dev.db'])
    expect(await setProjectKeptIgnoredPaths(APP, [])).toBe(true)
    expect((await getProjectRow(APP))?.keptIgnoredPaths).toEqual([])
    expect(await setProjectKeptIgnoredPaths('0a0a0a0a-0000-4000-8000-0000000000ff', [])).toBe(false)
  })
})

describe('setProjectInit', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('starts a project with none, points it at a workflow or a named one, and reports an unknown projectId', async () => {
    await recordProject({ id: P, name: 'p', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect((await getProjectRow(P))?.initWorkflowId).toBeUndefined()
    const workflow = await storeWorkflow(P, { steps: { install: { run: ['pnpm install'] } }, secrets: [] })
    expect(await setProjectInit(P, { workflowId: workflow.id })).toBe(true)
    expect((await getProjectRow(P))?.initWorkflowId).toBe(workflow.id)
    await insertNamedWorkflow(P, 'init', workflow.id)
    const named = await findNamedWorkflow(P, 'init')
    await setProjectInit(P, { namedWorkflowId: named!.id })
    expect((await getProjectRow(P))?.initWorkflowId).toBeUndefined()
    expect((await getProjectRow(P))?.initNamedWorkflowId).toBe(named!.id)
    await setProjectInit(P, null)
    expect((await getProjectRow(P))?.initNamedWorkflowId).toBeUndefined()
    expect(await setProjectInit('0a0a0a0a-0000-4000-8000-0000000000ff', null)).toBe(false)
  })
})

describe('setProjectConfig', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('replaces the settings it names, keeps the rest, and answers undefined for an unknown projectId', async () => {
    await recordProject({ id: P, name: 'p', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    const ports = [{ containerPort: 3000, hostPortStart: 3000 }]
    expect(await setProjectConfig(P, { portForwards: ports, npmCache: false }))
      .toEqual({ portForwards: ports, cacheVolumes: {}, nestedContainers: false, npmCache: false })
    expect(await setProjectConfig(P, { cacheVolumes: { pip: '/p' } }))
      .toEqual({ portForwards: ports, cacheVolumes: { pip: '/p' }, nestedContainers: false, npmCache: false })
    expect(await getProjectRow(P)).toMatchObject({ portForwards: ports, cacheVolumes: { pip: '/p' }, npmCache: false })
    expect(await setProjectConfig('0a0a0a0a-0000-4000-8000-0000000000ff', { npmCache: true })).toBeUndefined()
  })
})

const icon = (hash: string) => ({ mimeType: 'image/png', bytes: Buffer.from(hash), hash })

/** A fresh data dir holding projects APP and P, for the icon describes. */
function withIconProjects(): void {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordProject({ id: APP, name: 'app', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: P, name: 'p', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
  })
  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })
}

describe('setProjectIcon', () => {
  withIconProjects()

  it('stores a picture, then replaces it, pushing a fresh snapshot each time', async () => {
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
    await setProjectIcon(APP, icon('a'))
    await setProjectIcon(APP, { mimeType: 'image/jpeg', bytes: Buffer.from('b'), hash: 'b' })
    expect(await getProjectIcon(APP)).toEqual({ mimeType: 'image/jpeg', bytes: Buffer.from('b'), hash: 'b' })
    expect(pushes).toBe(2)
  })
})

describe('getProjectIcon', () => {
  withIconProjects()

  it('is undefined for a project without one, and once its project is deleted', async () => {
    expect(await getProjectIcon(APP)).toBeUndefined()
    await setProjectIcon(APP, icon('a'))
    await deleteProjectRow(APP)
    expect(await getProjectIcon(APP)).toBeUndefined()
  })
})

describe('deleteProjectIcon', () => {
  withIconProjects()

  it("removes only that project's picture", async () => {
    await setProjectIcon(APP, icon('a'))
    await setProjectIcon(P, icon('p'))
    await deleteProjectIcon(APP)
    expect(await getProjectIcon(APP)).toBeUndefined()
    expect(await getProjectIcon(P)).toEqual(icon('p'))
  })
})

describe('listProjectIconHashes', () => {
  withIconProjects()

  it('maps each project with a picture to its hash', async () => {
    expect(await listProjectIconHashes()).toEqual(new Map())
    await setProjectIcon(P, icon('p'))
    expect(await listProjectIconHashes()).toEqual(new Map([[P, 'p']]))
  })
})
