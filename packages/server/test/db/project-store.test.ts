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
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

describe('recordProject', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
    pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
  })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('records a project and reads it back', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })

    expect(await getProjectRow('app')).toEqual({
      slug: 'app',
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) as string,
      remoteUrl: 'https://x/app.git',
      addedAt: '2026-01-01',
      createDefaults: {},
      gitCredentialId: null,
      knownHostsEntry: null,
    })
  })

  // A host key was trusted for the remote it was fetched from; the same
  // record under a different remote must not carry it over.
  it('records the credential it was added with, and drops its host key when the remote changes', async () => {
    const cred = await insertGitCredential({ name: 'k', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac k' })
    await recordProject(
      { slug: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' },
      { id: cred.id, knownHostsEntry: 'x ssh-ed25519 HOST' },
    )
    await recordProject({ slug: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' })
    expect(await getProjectRow('app')).toMatchObject({ gitCredentialId: cred.id, knownHostsEntry: 'x ssh-ed25519 HOST' })

    await recordProject({ slug: 'app', remoteUrl: 'git@y:app.git', addedAt: '2026-01-01' })
    expect(await getProjectRow('app')).toMatchObject({ gitCredentialId: cred.id, knownHostsEntry: null })
  })

  // Re-adding the same slug is how a re-clone lands; the original addedAt is
  // the project's age and must not be reset by it.
  it('keeps the original addedAt when the same slug is recorded again', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    await recordProject({ slug: 'app', remoteUrl: 'https://y/app.git', addedAt: '2026-06-01' })

    expect(await getProjectRow('app')).toMatchObject({
      remoteUrl: 'https://y/app.git', addedAt: '2026-01-01',
    })
  })

  // The id names the project's substrate objects, so it must never follow
  // the slug: re-recording keeps it, and a project re-added under a freed
  // slug gets one of its own rather than inheriting the old one's objects.
  it('mints an id that survives a re-record and is never reused by a re-add', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    const first = (await getProjectRow('app'))?.id
    await recordProject({ slug: 'app', remoteUrl: 'https://y/app.git', addedAt: '2026-01-01' })
    expect((await getProjectRow('app'))?.id).toBe(first)

    await deleteProjectRow('app')
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-02-01' })
    const second = (await getProjectRow('app'))?.id
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
  })

  // The project list is a snapshot input, and this is its only INSERT — so
  // it is where a new project announces itself. Nothing above it pushes:
  // before this, a newly added project reached the sidebar only because a
  // reconcile pass happened to rebuild the snapshot afterwards.
  it('pushes a fresh snapshot', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    expect(pushes).toBe(1)
  })
})

describe('deleteProjectRow', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('removes the row and its create memory, and pushes a fresh snapshot', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    await recordProjectCreate('app', 'codex', { model: 'gpt-6-sol' })
    _resetWorktreeListChangedForTests()
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    await deleteProjectRow('app')
    expect(await getProjectRow('app')).toBeUndefined()
    expect(pushes).toBe(1)
    // A project re-added under the same slug starts with no memory rather
    // than inheriting the removed one's.
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-02-01' })
    expect(await getProjectRow('app')).toMatchObject({ createDefaults: {} })
    expect((await getProjectRow('app'))?.lastTool).toBeUndefined()
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
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    expect(await listProjectRows()).toEqual([
      {
        slug: 'app',
        id: (await getProjectRow('app'))?.id,
        remoteUrl: 'https://x/app.git',
        addedAt: '2026-01-01',
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
    _resetWorktreeListChangedForTests()
  })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('remembers the agent and what it was created with, per agent and per project', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    await recordProject({ slug: 'q', remoteUrl: 'git@h:o/s.git', addedAt: 'now' })
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    await recordProjectCreate('p', 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-6-sol' })
    expect(pushes).toBe(2)

    expect(await getProjectRow('p')).toMatchObject({
      lastTool: 'codex',
      createDefaults: {
        claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' },
        codex: { model: 'gpt-6-sol' },
      },
    })
    // Another project is untouched: the memory is per project.
    const q = await getProjectRow('q')
    expect(q?.lastTool).toBeUndefined()
    expect(q?.createDefaults).toEqual({})
    // And the list read carries the same memory as the point read.
    expect((await listProjectRows()).find((r) => r.slug === 'p')?.createDefaults)
      .toEqual((await getProjectRow('p'))?.createDefaults)
  })

  // A create that took the resolved default for a field names nothing for
  // it, and must not overwrite what a person picked — while the agent itself
  // is always the one this project was last created with.
  it('writes only the fields it is given', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    await recordProjectCreate('p', 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan' })
    await recordProjectCreate('p', 'claude', { mode: 'acp' })
    await recordProjectCreate('p', 'claude', {})

    expect(await getProjectRow('p')).toMatchObject({
      lastTool: 'claude',
      createDefaults: { claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' } },
    })

    // It survives a re-record of the project itself, which only rewrites the
    // remote (an `add` of a project that already exists).
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/moved.git', addedAt: 'now' })
    expect((await getProjectRow('p'))?.lastTool).toBe('claude')
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

  it('assigns the credential with its host key, replacing both, and reports an unknown slug', async () => {
    const a = await insertGitCredential({ name: 'a', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac a' })
    const b = await insertGitCredential({ name: 'b', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 BBBB yaac b' })
    await recordProject({ slug: 'app', remoteUrl: 'git@x:app.git', addedAt: '2026-01-01' })

    expect(await setProjectGitCredential('app', a.id, 'x ssh-ed25519 ONE')).toBe(true)
    expect(await setProjectGitCredential('app', b.id, 'x ssh-ed25519 TWO')).toBe(true)
    expect(await getProjectRow('app')).toMatchObject({ gitCredentialId: b.id, knownHostsEntry: 'x ssh-ed25519 TWO' })
    expect(await setProjectGitCredential('nope', a.id, null)).toBe(false)
  })
})
