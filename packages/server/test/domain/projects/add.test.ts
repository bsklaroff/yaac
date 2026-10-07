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
import {
  addHttpsCredential,
  addProject,
  generateSshCredential,
  registerStagedProject,
  resolveProjectCredential,
} from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb, getProjectRow, listProjectRows } from '#db'
import {
  claudeDir,
  getProjectsDir,
  repoDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '@yaac/shared/project-paths'
import {
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
  PLACEHOLDER_ACCESS_TOKEN,
} from '@yaac/shared/tool-auth'

const mockClone = vi.mocked(cloneRepo)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** What the projects dir holds; empty once a failed add rolls back. */
async function projectDirs(): Promise<string[]> {
  return fs.readdir(getProjectsDir()).catch(() => [])
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
  it('clones with the credential it is given and records the project with it', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_secret' })

    const { project, knownHostsEntry } = await addProject('https://github.com/acme/Widgets.git', id, BUILT_IN_USER_ID)

    expect(project.id).toMatch(UUID)
    expect(project.name).toBe('widgets')
    expect(project.remoteUrl).toBe('https://github.com/acme/Widgets.git')
    expect(Date.parse(project.addedAt)).not.toBeNaN()
    expect(await getProjectRow(project.id)).toMatchObject(project)

    expect(mockClone).toHaveBeenCalledWith(
      'https://github.com/acme/Widgets.git',
      repoDir(project.id),
      { kind: 'https', token: 'ghp_secret' },
    )
    expect(knownHostsEntry).toBeNull()
    expect(await resolveProjectCredential(project.id)).toEqual({ kind: 'https', token: 'ghp_secret' })
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
    expect(mockClone).toHaveBeenCalledWith('git@git.example.com:group/sub/Repo.git', repoDir(project.id), credential)
    expect(await resolveProjectCredential(project.id)).toEqual(credential)
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
    expect(rows.map((r) => r.remoteUrl).sort())
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
    await saveClaudeOAuthBundle({
      accessToken: 'real-access',
      refreshToken: 'real-refresh',
      expiresAt: Date.now() + 86_400_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })
    await saveCodexOAuthBundle({
      accessToken: 'real-access',
      refreshToken: 'real-refresh',
      idTokenRawJwt: 'header.payload.sig',
      expiresAt: Date.now() + 86_400_000,
      lastRefresh: '2026-01-01T00:00:00.000Z',
    })

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
      'ssh://git@github.com/acme/foo',
      'https://git.example.com:8443/a/b',
      'https://github.com/',
      'acme/foo',
      'not a url',
    ]) {
      await expect(addProject(bad, token, BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(mockClone).not.toHaveBeenCalled()
  })

  it('maps a rejected credential to VALIDATION and rolls the project dir back', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_stale' })
    mockClone.mockRejectedValue(new Error('fatal: Authentication failed for https://github.com/'))

    const attempt = addProject('https://github.com/acme/repo.git', id, BUILT_IN_USER_ID)
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(attempt).rejects.toThrow(/git authentication failed for github\.com/)
    expect(await projectDirs()).toEqual([])
  })

  it('maps any other clone failure to INTERNAL and rolls the project dir back', async () => {
    mockClone.mockRejectedValue(new Error('fatal: repository not found'))

    const attempt = addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/Failed to clone: fatal: repository not found/)
    expect(await projectDirs()).toEqual([])
  })

  it('rolls the project dir back when anything after the clone fails', async () => {
    // A file where the claude home goes makes setup after the clone fail.
    // A leftover dir with no row could not be listed, removed or re-added.
    mockClone.mockImplementation(async (_url, dest) => {
      await fs.mkdir(path.join(dest, '.git'), { recursive: true })
      await fs.writeFile(claudeDir(path.basename(path.dirname(dest))), 'in the way')
    })

    await expect(addProject('https://github.com/acme/repo.git', token, BUILT_IN_USER_ID)).rejects.toThrow()
    expect(await projectDirs()).toEqual([])
    expect(await listProjectRows()).toEqual([])
  })
})

const STAGED = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2c'
const LOCAL = '5c4b3a29-1807-4f6e-9d8c-7b6a5f4e3d2d'

describe('registerStagedProject', () => {
  it('records a staged checkout without cloning, and refuses what it cannot record', async () => {
    // Nothing staged yet.
    await expect(registerStagedProject(STAGED, 'staged', 'https://github.com/acme/staged.git', BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    await fs.mkdir(path.join(repoDir(STAGED), '.git'), { recursive: true })
    const meta = await registerStagedProject(STAGED, 'staged', 'https://github.com/acme/staged.git', BUILT_IN_USER_ID)
    expect(meta).toMatchObject({ id: STAGED, name: 'staged', remoteUrl: 'https://github.com/acme/staged.git' })
    expect(await getProjectRow(STAGED)).toMatchObject({ ...meta, gitCredentialId: null })
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
  })
})
