import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// Only the clone and the host-key fetch (the two process boundaries) are
// mocked. Credential lookup, name derivation, rollback and isGitAuthError
// run for real.
const HOST_KEY = 'git.example.com ssh-ed25519 AAAAHOST'
vi.mock('#domain/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  cloneRepo: vi.fn(),
  fetchKnownHostsEntry: vi.fn(() => Promise.resolve(HOST_KEY)),
}))

import { cloneRepo } from '#domain/git'
import type * as gitModule from '#domain/git'
import crypto from 'node:crypto'
import { addProject, createHostedProject, registerStagedProject } from '#domain/projects'
import { resolveRepoCredential } from '#domain/repos'
import { addHttpsCredential, generateSshCredential } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getProjectRow, listProjectRows, listRepos, recordProject, setToolCredential, type RepoRow } from '#db'
import {
  claudeDir,
  getProjectsDir,
  hostedRepoDir,
  repoDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '@yaac/shared/project-paths'
import { PLACEHOLDER_ACCESS_TOKEN } from '@yaac/shared/tool-auth'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { git } from '@yaac/test-utils/git'

const mockClone = vi.mocked(cloneRepo)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** What the projects dir holds; empty once a failed add rolls back. */
async function projectDirs(): Promise<string[]> {
  return fs.readdir(getProjectsDir()).catch(() => [])
}

/** The one repo a project links. */
async function repoOf(projectId: string): Promise<RepoRow> {
  const [link, ...rest] = (await getProjectRow(projectId))?.repos ?? []
  expect(rest).toEqual([])
  return link.repo
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

describe('addProject', () => {
  it('clones with the credential it is given and records the project around that repo', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_secret' })

    const { project, knownHostsEntry } = await addProject('https://github.com/acme/Widgets.git', id, BUILT_IN_USER_ID)

    expect(project.id).toMatch(UUID)
    expect(project.name).toBe('widgets')
    expect(Date.parse(project.addedAt)).not.toBeNaN()
    const row = await getProjectRow(project.id)
    expect(row).toMatchObject(project)
    // One repo of its own id, linked under a folder named for the project.
    expect(row?.repos).toMatchObject([{
      dir: 'widgets',
      readOnly: false,
      ghToken: true,
      lastIncluded: true,
      repo: { owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/Widgets.git', hosted: false, gitCredentialId: id },
    }])
    const repo = await repoOf(project.id)
    expect(repo.id).not.toBe(project.id)

    expect(mockClone).toHaveBeenCalledWith(
      'https://github.com/acme/Widgets.git',
      repoDir(repo.id),
      { kind: 'https', token: 'ghp_secret' },
    )
    expect(knownHostsEntry).toBeNull()
    expect(await resolveRepoCredential(repo)).toEqual({ kind: 'https', token: 'ghp_secret' })
  })

  it('links the repo its owner already has for the remote, rather than cloning again', async () => {
    const url = 'https://github.com/acme/widgets.git'
    const first = await addProject(url, token, BUILT_IN_USER_ID)
    const other = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'other', token: 'ghp_other' })

    const second = await addProject(url, other.id, BUILT_IN_USER_ID)

    expect(second.project.id).not.toBe(first.project.id)
    expect(mockClone).toHaveBeenCalledTimes(1)
    // One repo, which keeps the credential it had.
    const repo = await repoOf(second.project.id)
    expect(repo.id).toBe((await repoOf(first.project.id)).id)
    expect(repo.gitCredentialId).toBe(token)
    expect(await listRepos()).toHaveLength(1)
  })

  it('clones an SCP-style remote with an ssh key, trusting the host key it fetched', async () => {
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })

    const { project, knownHostsEntry } = await addProject(
      'git@git.example.com:group/sub/Repo.git', key.id, BUILT_IN_USER_ID,
    )

    expect(project.name).toBe('repo')
    expect(knownHostsEntry).toBe(HOST_KEY)
    // The clone gets only the public key; the ssh-agent signs.
    const credential = { kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY }
    const repo = await repoOf(project.id)
    expect(mockClone).toHaveBeenCalledWith('git@git.example.com:group/sub/Repo.git', repoDir(repo.id), credential)
    expect(await resolveRepoCredential(repo)).toEqual(credential)
  })

  // Names are converted, not refused. They need not be unique: the id names
  // the project, so a second add of a remote is a second project.
  it('derives a name from any repo path, and adds a repeated name as its own project', async () => {
    const long = `${'a'.repeat(70)}`
    const cases: Array<[string, string]> = [
      ['https://github.com/acme/C++Lib.git', 'c--lib'],
      ['https://github.com/acme/.dotfiles_.git', 'dotfiles'],
      ['https://github.com/acme/a%20b.git', 'a-20b'],
      [`https://github.com/acme/${long}.git`, 'a'.repeat(63)],
      ['https://github.com/acme/c++lib!.git', 'c--lib'],
    ]
    for (const [url, name] of cases) {
      expect((await addProject(url, token, BUILT_IN_USER_ID)).project.name).toBe(name)
    }
    const rows = (await listProjectRows()).filter((r) => r.name === 'c--lib')
    expect(rows.map((r) => r.repos[0].repo.remoteUrl).sort())
      .toEqual(['https://github.com/acme/C++Lib.git', 'https://github.com/acme/c++lib!.git'])
    expect(rows[0].id).not.toBe(rows[1].id)
  })

  it('refuses a credential of the wrong kind, or none that exists, before cloning', async () => {
    await expect(addProject('git@github.com:acme/repo.git', token, BUILT_IN_USER_ID))
      .rejects.toThrow(/needs an SSH key, not a token/)
    await expect(addProject('https://github.com/acme/repo.git', '00000000-0000-4000-8000-000000000000', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClone).not.toHaveBeenCalled()
    expect(await projectDirs()).toEqual([])
  })

  it('seeds the project with placeholder tool credentials when the user has them', async () => {
    await setToolCredential(BUILT_IN_USER_ID, 'claude', { kind: 'oauth', savedAt: 'x', claudeAiOauth: {
      accessToken: 'real-access',
      refreshToken: 'real-refresh',
      expiresAt: Date.now() + 86_400_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    } })
    await setToolCredential(BUILT_IN_USER_ID, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: {
      accessToken: 'real-access',
      refreshToken: 'real-refresh',
      idTokenRawJwt: 'header.payload.sig',
      expiresAt: Date.now() + 86_400_000,
      lastRefresh: '2026-01-01T00:00:00.000Z',
    } })

    const { project } = await addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)

    // Placeholders, not real tokens; the proxy swaps them per request.
    const claude = JSON.parse(
      await fs.readFile(projectClaudeCredentialsFile(project.id), 'utf8'),
    ) as { claudeAiOauth: { accessToken: string } }
    expect(claude.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)

    const codex = JSON.parse(await fs.readFile(projectCodexAuthFile(project.id), 'utf8')) as {
      tokens: { access_token: string }
    }
    expect(codex.tokens.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('leaves the tool credential dirs empty when the user has no oauth login', async () => {
    const { project } = await addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)

    await expect(fs.access(projectClaudeCredentialsFile(project.id))).rejects.toThrow()
    await expect(fs.access(projectCodexAuthFile(project.id))).rejects.toThrow()
  })

  it('rejects a remote URL it cannot parse as VALIDATION', async () => {
    for (const bad of [
      'http://github.com/acme/foo',
      'ssh://git@github.com:2222/acme/foo',
      'https://git.example.com:8443/a/b',
      'https://github.com/',
      'acme/foo',
      'not a url',
    ]) {
      await expect(addProject(bad, token, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(mockClone).not.toHaveBeenCalled()
  })

  it('maps a rejected credential to VALIDATION and leaves no project, repo or clone', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_stale' })
    mockClone.mockRejectedValue(new Error('fatal: Authentication failed for https://github.com/'))

    const attempt = addProject('https://github.com/acme/repo.git', id, BUILT_IN_USER_ID)
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(attempt).rejects.toThrow(/git authentication failed for github\.com/)
    expect(await projectDirs()).toEqual([])
    expect(await listRepos()).toEqual([])
    expect(await fs.readdir(path.dirname(repoDir('x')))).toEqual([])
  })

  it('maps any other clone failure to INTERNAL and leaves no project', async () => {
    mockClone.mockRejectedValue(new Error('fatal: repository not found'))

    const attempt = addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/Failed to clone: fatal: repository not found/)
    expect(await projectDirs()).toEqual([])
  })

  it('rolls the project dir back when anything after the clone fails, keeping the repo', async () => {
    // A file where the claude home goes makes setup after the clone fail.
    // A leftover dir with no row could not be listed, removed or re-added.
    // The ids are pinned (the repo's, then the project's) to know where.
    const ids = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(LOCAL).mockReturnValueOnce(STAGED)
    mockClone.mockImplementation(async (_url, dest) => {
      await fs.mkdir(path.join(dest, '.git'), { recursive: true })
      await fs.mkdir(path.join(getProjectsDir(), STAGED), { recursive: true })
      await fs.writeFile(claudeDir(STAGED), 'in the way')
    })

    try {
      await expect(addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)).rejects.toThrow()
    } finally {
      ids.mockRestore()
    }
    expect(await projectDirs()).toEqual([])
    expect(await listProjectRows()).toEqual([])
    // The repo stays among its owner's, ready to link.
    expect((await listRepos()).map((r) => r.id)).toEqual([LOCAL])
  })
})

describe('createHostedProject', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof gitModule>('#domain/git')
    mockClone.mockImplementation(real.cloneRepo)
  })

  it('makes an empty hosted repo, clones it as the main clone, and records a project that needs no credential', async () => {
    const project = await createHostedProject('  My App! ', BUILT_IN_USER_ID)

    expect(project.id).toMatch(UUID)
    expect(project.name).toBe('my-app')
    expect(await getProjectRow(project.id)).toMatchObject(project)
    const repo = await repoOf(project.id)
    expect(repo).toMatchObject({
      remoteUrl: hostedRemoteUrl(repo.id),
      hosted: true,
      guardDefaultBranch: true,
      gitCredentialId: null,
    })
    expect((await getProjectRow(project.id))?.repos[0].dir).toBe('my-app')
    expect(await resolveRepoCredential(repo)).toEqual({ kind: 'hosted' })

    // The main clone is a clone of the bare remote, from the path on disk.
    expect(mockClone).toHaveBeenCalledWith(hostedRepoDir(repo.id), repoDir(repo.id), { kind: 'hosted' })
    expect((await git(hostedRepoDir(repo.id), ['rev-parse', '--is-bare-repository'])).trim()).toBe('true')
    expect((await git(repoDir(repo.id), ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main')
    await expect(fs.access(claudeDir(project.id))).resolves.toBeUndefined()
  })

  it('refuses a name with nothing usable in it, but not one another project has', async () => {
    await expect(createHostedProject('!!!', BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await projectDirs()).toEqual([])

    // Names need not be unique; ids tell projects apart.
    await recordProject({ id: STAGED, name: 'widgets', addedAt: '' }, BUILT_IN_USER_ID)
    expect((await createHostedProject('Widgets', BUILT_IN_USER_ID)).name).toBe('widgets')
    expect(await listProjectRows()).toHaveLength(2)
  })

  it('leaves no project, repo or remote when the repo cannot be made', async () => {
    mockClone.mockRejectedValueOnce(new Error('disk full'))

    await expect(createHostedProject('app', BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(await projectDirs()).toEqual([])
    expect(await fs.readdir(path.dirname(hostedRepoDir('x')))).toEqual([])
    expect(await listProjectRows()).toEqual([])
    expect(await listRepos()).toEqual([])
  })
})

const STAGED = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2c'
const LOCAL = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2d'

describe('registerStagedProject', () => {
  it('records a staged main clone as a project and a repo of one id, without cloning, and refuses what it cannot record', async () => {
    // Nothing staged yet.
    await expect(registerStagedProject(STAGED, 'staged', 'https://github.com/acme/staged.git', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    await fs.mkdir(path.join(repoDir(STAGED), '.git'), { recursive: true })
    const meta = await registerStagedProject(STAGED, 'staged', 'https://github.com/acme/staged.git', BUILT_IN_USER_ID)
    expect(meta).toMatchObject({ id: STAGED, name: 'staged' })
    expect(await getProjectRow(STAGED)).toMatchObject({
      ...meta,
      repos: [{ dir: 'staged', repo: { id: STAGED, remoteUrl: 'https://github.com/acme/staged.git', gitCredentialId: null } }],
    })
    expect(mockClone).not.toHaveBeenCalled()

    await expect(registerStagedProject(STAGED, 'staged', 'https://github.com/other/staged.git', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    // The remote is validated as `addProject` does, since it picks the
    // transport every later fetch uses.
    await fs.mkdir(path.join(repoDir(LOCAL), '.git'), { recursive: true })
    for (const remote of ['/some/local/path', 'file:///srv/repo.git', 'ext::sh -c evil']) {
      await expect(registerStagedProject(LOCAL, 'local', remote, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(await getProjectRow(LOCAL)).toBeUndefined()
    expect((await listRepos()).map((r) => r.id)).toEqual([STAGED])
  })
})
