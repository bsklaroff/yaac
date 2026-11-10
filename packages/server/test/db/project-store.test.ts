import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  clearProjectKeepsHostedRepo,
  deleteProjectIcon,
  deleteProjectRow,
  getProjectIcon,
  getProjectRow,
  listProjectIconHashes,
  listProjectRows,
  recordProject,
  recordProjectCreate,
  setProjectConfig,
  setProjectDefaultBranchGuard,
  setProjectKeptIgnoredPaths,
  setProjectWorkspaceRetention,
  setProjectEgressAllowlist,
  setProjectScratchDirs,
  setProjectGitCredential,
  setProjectIcon,
  setProjectInit,
  setProjectOrder,
  setProjectRemote,
  setProjectShareRevoked,
} from '#db/project-store'
import { insertGitCredential } from '#db/git-credential-store'
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

    expect(await getProjectRow(APP)).toEqual({
      id: APP,
      name: 'app',
      remoteUrl: 'https://x/app.git',
      addedAt: '2026-01-01',
      owner: BUILT_IN_USER_ID,
      createDefaults: {},
      gitCredentialId: null,
      knownHostsEntry: null,
      egressAllowlist: { hosts: [], defaults: true },
      hosted: false,
      guardDefaultBranch: true,
      keepsHostedRepo: false,
      shareRevoked: false,
      keptIgnoredPaths: [],
      scratchDirs: { dirs: [{ path: 'node_modules' }, { path: 'target' }], ignoredTracked: [] },
      portForwards: [],
      cacheVolumes: {},
      nestedContainers: false,
      npmCache: true,
    })
  })

  // A host key was trusted for the remote it was fetched from; the same
  // record under a different remote must not carry it over.
  it('records the credential it was added with, and drops its host key when the remote changes', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'k', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac k' })
    await recordProject(
      { id: APP, name: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' },
      BUILT_IN_USER_ID,
      { id: cred.id, knownHostsEntry: 'x ssh-ed25519 HOST' },
    )
    await recordProject({ id: APP, name: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(await getProjectRow(APP)).toMatchObject({ gitCredentialId: cred.id, knownHostsEntry: 'x ssh-ed25519 HOST' })

    await recordProject({ id: APP, name: 'app', remoteUrl: 'git@y:app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(await getProjectRow(APP)).toMatchObject({ gitCredentialId: cred.id, knownHostsEntry: null })
  })

  // Re-recording the same id is how a re-clone lands; the original addedAt is
  // the project's age and must not be reset by it.
  it('keeps the original addedAt when the same projectId is recorded again', async () => {
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://y/app.git', addedAt: '2026-06-01' }, BUILT_IN_USER_ID)

    expect(await getProjectRow(APP)).toMatchObject({
      remoteUrl: 'https://y/app.git', addedAt: '2026-01-01',
    })
  })

  // The project list is a snapshot input and this is its only INSERT, so
  // this is where a new project notifies.
  it('pushes a fresh snapshot', async () => {
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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

  it('removes the row and its create memory, and pushes a fresh snapshot', async () => {
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProjectCreate(APP, 'codex', { model: 'gpt-6-sol' })
    _resetWorkspaceListChangedForTests()
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    await deleteProjectRow(APP)
    expect(await getProjectRow(APP)).toBeUndefined()
    expect(pushes).toBe(1)
    // A project re-added under the same id starts with no memory rather
    // than inheriting the removed one's.
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-02-01' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect(await listProjectRows()).toEqual([
      {
        id: APP,
        name: 'app',
        remoteUrl: 'https://x/app.git',
        addedAt: '2026-01-01',
        owner: BUILT_IN_USER_ID,
        createDefaults: {},
        gitCredentialId: null,
        knownHostsEntry: null,
        egressAllowlist: { hosts: [], defaults: true },
        hosted: false,
        guardDefaultBranch: true,
        keepsHostedRepo: false,
        shareRevoked: false,
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
    await recordProject({ id: P, name: 'p', remoteUrl: 'https://x/p.git', addedAt: '2026-01-02' }, BUILT_IN_USER_ID)
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    // An update rewrites the row, which must not move it.
    await setProjectDefaultBranchGuard(APP, false)
    expect((await listProjectRows()).map((r) => r.id)).toEqual([APP, P])
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
      await recordProject({ id, name: id, remoteUrl: 'https://x/r.git', addedAt }, owner)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: P, name: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' }, BUILT_IN_USER_ID)
    await recordProject({ id: Q, name: 'q', remoteUrl: 'git@h:o/s.git', addedAt: 'now' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: P, name: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' }, BUILT_IN_USER_ID)
    await recordProjectCreate(P, 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan' }, 'develop')
    await recordProjectCreate(P, 'claude', { mode: 'acp' })
    await recordProjectCreate(P, 'claude', {})

    expect(await getProjectRow(P)).toMatchObject({
      lastTool: 'claude',
      lastBranch: 'develop',
      createDefaults: { claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' } },
    })

    // It survives a re-record of the project itself, which only rewrites the
    // remote (an `add` of a project that already exists).
    await recordProject({ id: P, name: 'p', remoteUrl: 'git@h:o/moved.git', addedAt: 'now' }, BUILT_IN_USER_ID)
    expect((await getProjectRow(P))?.lastTool).toBe('claude')
  })
})

describe('setProjectGitCredential', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('assigns the credential with its host key, replacing both, and reports an unknown projectId', async () => {
    const a = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'a', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac a' })
    const b = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'b', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 BBBB yaac b' })
    await recordProject({ id: APP, name: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

    expect(await setProjectGitCredential(APP, a.id, 'x ssh-ed25519 ONE')).toBe(true)
    expect(await setProjectGitCredential(APP, b.id, 'x ssh-ed25519 TWO')).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ gitCredentialId: b.id, knownHostsEntry: 'x ssh-ed25519 TWO' })
    expect(await setProjectGitCredential('0a0a0a0a-0000-4000-8000-0000000000ff', a.id, null)).toBe(false)
  })
})

describe('setProjectRemote', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('points a hosted project and its shares at a remote, the credential its alone, and reports an unknown projectId', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac gh' })
    const hosted = (id: string): string => `http://yaac.internal/api/workspace/git/${id}.git`
    await recordProject({ id: APP, name: 'app', remoteUrl: hosted(APP), addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    const [ada, bob] = await Promise.all([seeTailnetUser('ada@example.com', 'Ada'), seeTailnetUser('bob@example.com', 'Bob')])
    await recordProject({ id: P, name: 'app', remoteUrl: hosted(P), addedAt: '2026-01-01', hosted: true, sharedFrom: APP }, ada)
    await recordProject({ id: Q, name: 'app', remoteUrl: hosted(Q), addedAt: '2026-01-01', hosted: true, sharedFrom: APP }, bob)
    await setProjectShareRevoked(Q, true)
    const seen: number[] = []
    _resetWorkspaceListChangedForTests()
    onWorkspaceListChanged(() => seen.push(1))

    const remote = 'git@github.com:acme/app.git'
    expect(await setProjectRemote(APP, remote, { id: cred.id, knownHostsEntry: 'github.com ssh-ed25519 KEY' })).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({
      remoteUrl: remote, hosted: false, keepsHostedRepo: true, gitCredentialId: cred.id, knownHostsEntry: 'github.com ssh-ed25519 KEY',
    })
    // An active share becomes a project of its own; a removed one stays
    // removed, and so read-only. Neither has a repository of its own.
    const share = await getProjectRow(P)
    expect(share).toMatchObject({ remoteUrl: remote, hosted: false, keepsHostedRepo: false, gitCredentialId: null, knownHostsEntry: null })
    expect(share?.sharedFrom).toBeUndefined()
    expect(await getProjectRow(Q)).toMatchObject({ remoteUrl: remote, hosted: false, sharedFrom: APP, shareRevoked: true })
    expect(seen.length).toBeGreaterThan(0)
    expect(await setProjectRemote('0a0a0a0a-0000-4000-8000-0000000000ff', remote, { id: cred.id, knownHostsEntry: null })).toBe(false)
  })
})

describe('clearProjectKeepsHostedRepo', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('records that a moved project keeps no old repository, and reports an unknown projectId', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'https', secret: 'ghp_x' })
    await recordProject({ id: APP, name: 'app', remoteUrl: `http://yaac.internal/api/workspace/git/${APP}.git`, addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    await setProjectRemote(APP, 'https://github.com/acme/app.git', { id: cred.id, knownHostsEntry: null })

    expect(await clearProjectKeepsHostedRepo(APP)).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ keepsHostedRepo: false, remoteUrl: 'https://github.com/acme/app.git' })
    expect(await clearProjectKeepsHostedRepo('0a0a0a0a-0000-4000-8000-0000000000ff')).toBe(false)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

    expect(await setProjectEgressAllowlist(APP, { hosts: ['a.com'], defaults: true })).toBe(true)
    expect(await setProjectEgressAllowlist(APP, { hosts: ['b.com'], defaults: false })).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ egressAllowlist: { hosts: ['b.com'], defaults: false } })
    expect(await setProjectEgressAllowlist('0a0a0a0a-0000-4000-8000-0000000000ff', { hosts: [], defaults: true }))
      .toBe(false)
  })
})

describe('setProjectDefaultBranchGuard', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('records a hosted project with the guard on, toggles it, and reports an unknown projectId', async () => {
    await recordProject({ id: APP, name: 'app', remoteUrl: 'http://yaac.internal/x.git', addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    expect(await getProjectRow(APP)).toMatchObject({ hosted: true, guardDefaultBranch: true })

    expect(await setProjectDefaultBranchGuard(APP, false)).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ guardDefaultBranch: false })
    expect(await setProjectDefaultBranchGuard('0a0a0a0a-0000-4000-8000-0000000000ff', true)).toBe(false)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://example.com/x.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    expect((await getProjectRow(APP))?.stoppedWorkspaceRetentionDays).toBeUndefined()

    expect(await setProjectWorkspaceRetention(APP, 30)).toBe(true)
    expect(await getProjectRow(APP)).toMatchObject({ stoppedWorkspaceRetentionDays: 30 })
    expect(await setProjectWorkspaceRetention(APP, null)).toBe(true)
    expect((await getProjectRow(APP))?.stoppedWorkspaceRetentionDays).toBeUndefined()
    expect(await setProjectWorkspaceRetention('0a0a0a0a-0000-4000-8000-0000000000ff', 30)).toBe(false)
  })
})

describe('setProjectShareRevoked', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('removes a share and gives it back, and reports an unknown projectId', async () => {
    await recordProject({ id: APP, name: 'app', remoteUrl: 'http://yaac.internal/a.git', addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    await recordProject({ id: P, name: 'app', remoteUrl: 'http://yaac.internal/p.git', addedAt: '2026-01-01', hosted: true, sharedFrom: APP }, BUILT_IN_USER_ID)
    expect((await getProjectRow(APP))?.sharedFrom).toBeUndefined()
    expect(await getProjectRow(P)).toMatchObject({ sharedFrom: APP, shareRevoked: false })

    expect(await setProjectShareRevoked(P, true)).toBe(true)
    expect(await getProjectRow(P)).toMatchObject({ shareRevoked: true })
    expect(await setProjectShareRevoked(P, false)).toBe(true)
    expect(await getProjectRow(P)).toMatchObject({ shareRevoked: false })
    expect(await setProjectShareRevoked('0a0a0a0a-0000-4000-8000-0000000000ff', true)).toBe(false)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://example.com/x.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: P, name: 'p', remoteUrl: 'https://github.com/o/p.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: P, name: 'p', remoteUrl: 'https://github.com/o/p.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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
    await recordProject({ id: APP, name: 'app', remoteUrl: 'https://example.com/x.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: P, name: 'p', remoteUrl: 'https://example.com/p.git', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
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
