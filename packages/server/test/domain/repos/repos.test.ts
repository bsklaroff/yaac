import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// Only the clone and the host-key fetch (the two process boundaries) are
// mocked. Credential lookup, rollback and isGitAuthError run for real.
const HOST_KEY = 'git.example.com ssh-ed25519 AAAAHOST'
vi.mock('#domain/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  cloneRepo: vi.fn(),
  fetchKnownHostsEntry: vi.fn(() => Promise.resolve(HOST_KEY)),
}))

import { cloneRepo } from '#domain/git'
import type * as gitModule from '#domain/git'
import { addRepo, createHostedRepo, listRepoSummaries, registerStagedRepo, shareRepo } from '#domain/repos'
import { addHttpsCredential, generateSshCredential } from '#domain/auth'
import {
  applyWorkspaceEvent,
  BUILT_IN_USER_ID,
  closeDb,
  getRepo,
  linkProjectRepo,
  listRepos,
  listRepoShares,
  markRepoDeleted,
  seeTailnetUser,
} from '#db'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { git } from '@yaac/test-utils/git'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const mockClone = vi.mocked(cloneRepo)
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAGED = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2c'
const OTHER = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2d'

/** The main clones on disk; empty once a failed add rolls back. */
async function mainClones(): Promise<string[]> {
  return fs.readdir(path.dirname(repoDir('x'))).catch(() => [])
}

let tmpDir: string
/** A token credential every case may clone with. */
let token: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'default', token: 'ghp_default' })).id
  mockClone.mockReset()
  // Leave a repo behind, as a real clone does, for rollback to remove.
  mockClone.mockImplementation(async (_url, dest) => {
    await fs.mkdir(path.join(dest, '.git'), { recursive: true })
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('addRepo', () => {
  it('clones a remote its owner does not have yet, under the credential it is given', async () => {
    const { repo, knownHostsEntry } = await addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/Widgets.git', token)

    expect(repo.id).toMatch(UUID)
    expect(repo).toMatchObject({
      owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/Widgets.git', hosted: false, gitCredentialId: token, knownHostsEntry: null,
    })
    expect(Date.parse(repo.addedAt)).not.toBeNaN()
    expect(knownHostsEntry).toBeNull()
    expect(mockClone).toHaveBeenCalledWith('https://github.com/acme/Widgets.git', repoDir(repo.id), { kind: 'https', token: 'ghp_default' })
    expect(await getRepo(repo.id)).toEqual(repo)

    // An ssh remote trusts the host key it fetched; the clone gets only the
    // public key.
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    const ssh = await addRepo(BUILT_IN_USER_ID, 'git@git.example.com:group/sub/Repo.git', key.id)
    expect(ssh.knownHostsEntry).toBe(HOST_KEY)
    expect(ssh.repo).toMatchObject({ gitCredentialId: key.id, knownHostsEntry: HOST_KEY })
    expect(mockClone).toHaveBeenLastCalledWith(
      'git@git.example.com:group/sub/Repo.git', repoDir(ssh.repo.id),
      { kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY },
    )
  })

  it('answers the repo its owner already has for the remote, which takes the credential only if it has none', async () => {
    const url = 'https://github.com/acme/widgets.git'
    const first = await addRepo(BUILT_IN_USER_ID, url, token)
    const other = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'other', token: 'ghp_other' })).id

    expect((await addRepo(BUILT_IN_USER_ID, url, other)).repo).toEqual(first.repo)
    expect(mockClone).toHaveBeenCalledTimes(1)

    // One staged with no credential takes the one it is added with.
    await fs.mkdir(path.join(repoDir(STAGED), '.git'), { recursive: true })
    await registerStagedRepo(STAGED, 'https://github.com/acme/staged.git', BUILT_IN_USER_ID)
    const taken = await addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/staged.git', other)
    expect(taken.repo).toMatchObject({ id: STAGED, gitCredentialId: other })
    expect((await getRepo(STAGED))?.gitCredentialId).toBe(other)
    expect(mockClone).toHaveBeenCalledTimes(1)

    // Another user's repo for the URL is theirs: a main clone holds what its
    // owner's credential fetched. So is a repo its owner deleted.
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const adas = (await addHttpsCredential(ada, { name: 'gh', token: 'ghp_ada' })).id
    const hers = await addRepo(ada, url, adas)
    expect(hers.repo.id).not.toBe(first.repo.id)
    await markRepoDeleted(first.repo.id)
    expect((await addRepo(BUILT_IN_USER_ID, url, token)).repo.id).not.toBe(first.repo.id)
    expect(mockClone).toHaveBeenCalledTimes(3)
  })

  it('refuses a remote or credential that does not fit, before cloning', async () => {
    for (const bad of ['http://github.com/acme/foo', 'ssh://git@github.com:2222/acme/foo', 'https://github.com/', 'acme/foo']) {
      await expect(addRepo(BUILT_IN_USER_ID, bad, token)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(addRepo(BUILT_IN_USER_ID, 'git@github.com:acme/repo.git', token)).rejects.toThrow(/needs an SSH key, not a token/)
    await expect(addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/repo.git', OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClone).not.toHaveBeenCalled()
    expect(await listRepos()).toEqual([])
  })

  it('maps a rejected credential to VALIDATION, any other clone failure to INTERNAL, and leaves nothing either way', async () => {
    mockClone.mockImplementation(async (_url, dest) => {
      await fs.mkdir(path.join(dest, '.git'), { recursive: true })
      throw new Error('fatal: Authentication failed for https://github.com/')
    })
    const rejected = addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/repo.git', token)
    await expect(rejected).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(rejected).rejects.toThrow(/git authentication failed for github\.com/)

    mockClone.mockRejectedValue(new Error('fatal: repository not found'))
    const missing = addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/repo.git', token)
    await expect(missing).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(missing).rejects.toThrow(/Failed to clone: fatal: repository not found/)

    expect(await mainClones()).toEqual([])
    expect(await listRepos()).toEqual([])
  })
})

describe('createHostedRepo', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof gitModule>('#domain/git')
    mockClone.mockImplementation(real.cloneRepo)
  })

  it('makes an empty bare repository, clones it as the main clone, and records a repo that needs no credential', async () => {
    const repo = await createHostedRepo(BUILT_IN_USER_ID)

    expect(repo).toMatchObject({
      owner: BUILT_IN_USER_ID, remoteUrl: hostedRemoteUrl(repo.id), hosted: true, guardDefaultBranch: true, gitCredentialId: null,
    })
    // The main clone is a clone of the bare remote, from the path on disk.
    expect(mockClone).toHaveBeenCalledWith(hostedRepoDir(repo.id), repoDir(repo.id), { kind: 'hosted' })
    expect((await git(hostedRepoDir(repo.id), ['rev-parse', '--is-bare-repository'])).trim()).toBe('true')
    expect((await git(repoDir(repo.id), ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main')
  })

  it('leaves no repository, clone or row when it fails', async () => {
    mockClone.mockRejectedValueOnce(new Error('disk full'))

    await expect(createHostedRepo(BUILT_IN_USER_ID)).rejects.toMatchObject({
      code: 'INTERNAL', message: expect.stringMatching(/Failed to create the repository: disk full/) as string,
    })
    expect(await fs.readdir(path.dirname(hostedRepoDir('x')))).toEqual([])
    expect(await mainClones()).toEqual([])
    expect(await listRepos()).toEqual([])
  })
})

describe('registerStagedRepo', () => {
  it('records a staged main clone without cloning, and refuses what it cannot record', async () => {
    // Nothing staged yet.
    await expect(registerStagedRepo(STAGED, 'https://github.com/acme/staged.git', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    await fs.mkdir(path.join(repoDir(STAGED), '.git'), { recursive: true })
    const repo = await registerStagedRepo(STAGED, 'https://github.com/acme/staged.git', BUILT_IN_USER_ID)
    expect(repo).toMatchObject({ id: STAGED, remoteUrl: 'https://github.com/acme/staged.git', gitCredentialId: null, hosted: false })
    expect(mockClone).not.toHaveBeenCalled()

    await expect(registerStagedRepo(STAGED, 'https://github.com/other/staged.git', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    // The remote is validated as `addRepo` does, since it picks the
    // transport every later fetch uses.
    await fs.mkdir(path.join(repoDir(OTHER), '.git'), { recursive: true })
    for (const remote of ['/some/local/path', 'file:///srv/repo.git', 'ext::sh -c evil']) {
      await expect(registerStagedRepo(OTHER, remote, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(await getRepo(OTHER)).toBeUndefined()
  })
})

describe('shareRepo', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof gitModule>('#domain/git')
    mockClone.mockImplementation(real.cloneRepo)
  })

  it("is the owner's alone, for a repo yaac hosts, with another user of the install, once", async () => {
    const hosted = await createHostedRepo(BUILT_IN_USER_ID)
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const asAda = { kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' } as const
    await fs.mkdir(path.join(repoDir(STAGED), '.git'), { recursive: true })
    await registerStagedRepo(STAGED, 'https://github.com/acme/widgets.git', BUILT_IN_USER_ID)

    await shareRepo(local, hosted.id, ada)
    await shareRepo(local, hosted.id, ada)
    expect(await listRepoShares()).toEqual([{ repoId: hosted.id, userId: ada }])

    // A user it is shared with does not share it on.
    await expect(shareRepo(asAda, hosted.id, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // One hosted elsewhere is reached with a credential each user brings.
    await expect(shareRepo(local, STAGED, ada)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(shareRepo(local, hosted.id, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(shareRepo(local, hosted.id, OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(shareRepo(local, OTHER, ada)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const gone = await createHostedRepo(BUILT_IN_USER_ID)
    await markRepoDeleted(gone.id)
    await expect(shareRepo(local, gone.id, ada)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await listRepoShares()).toHaveLength(1)
  })
})

describe('listRepoSummaries', () => {
  it('lists every repo with its credential, the projects that link it, whom it is shared with, and what holds a deleted one', async () => {
    const real = await vi.importActual<typeof gitModule>('#domain/git')
    mockClone.mockImplementationOnce(real.cloneRepo)
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const hosted = await createHostedRepo(BUILT_IN_USER_ID)
    const { repo: cloned } = await addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/widgets.git', token)
    const { repo: unlinked } = await addRepo(BUILT_IN_USER_ID, 'https://github.com/acme/spare.git', token)
    await shareRepo(local, hosted.id, ada)
    const MINE = '0a0a0a0a-0000-4000-8000-000000000001'
    const HERS = '0a0a0a0a-0000-4000-8000-000000000002'
    await recordTestProject(MINE, { repo: false, name: 'mine' })
    await recordTestProject(HERS, { repo: false, name: 'hers', owner: ada })
    await linkProjectRepo(MINE, hosted.id, 'app')
    await linkProjectRepo(MINE, cloned.id, 'widgets')
    await linkProjectRepo(HERS, hosted.id, 'app')

    // Listed oldest first; these were added within the same instant.
    const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((x, y) => x.id.localeCompare(y.id))
    expect(byId(await listRepoSummaries())).toEqual(byId([
      {
        id: hosted.id, owner: BUILT_IN_USER_ID, remoteUrl: hostedRemoteUrl(hosted.id), hosted: true, guardDefaultBranch: true,
        gitCredential: null,
        projects: [{ id: MINE, name: 'mine', owner: BUILT_IN_USER_ID }, { id: HERS, name: 'hers', owner: ada }],
        sharedWith: [ada],
      },
      {
        id: cloned.id, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/widgets.git', hosted: false, guardDefaultBranch: true,
        gitCredential: { id: token, name: 'default' },
        projects: [{ id: MINE, name: 'mine', owner: BUILT_IN_USER_ID }],
        sharedWith: [],
      },
      {
        id: unlinked.id, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/spare.git', hosted: false, guardDefaultBranch: true,
        gitCredential: { id: token, name: 'default' },
        projects: [],
        sharedWith: [],
      },
    ]))

    // A deleted repo names the workspaces that still hold a checkout of it.
    await applyWorkspaceEvent({
      type: 'workspace-created', projectId: HERS, workspaceId: 'w-hers', repos: [{ repoId: cloned.id, path: '' }], cwd: '',
    })
    await markRepoDeleted(cloned.id)
    expect((await listRepoSummaries()).find((r) => r.id === cloned.id)).toMatchObject({
      gitCredential: null,
      deleted: { heldBy: [{ workspaceId: 'w-hers', projectId: HERS, projectName: 'hers', owner: ada }] },
    })
    expect((await listRepoSummaries()).find((r) => r.id === hosted.id)).not.toHaveProperty('deleted')
  })
})
