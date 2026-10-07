import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  deleteProjectRow,
  getProjectRow,
  listProjectRows,
  recordProject,
  recordProjectCreate,
  setProjectGitCredential,
} from '#db/project-store'
import { insertGitCredential } from '#db/git-credential-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

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
      },
    ])
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
