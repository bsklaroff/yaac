import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The clone and the host-key fetch are the two things this feature shells
// out for. Faking them (and only them) keeps every credential lookup, slug
// derivation, and rollback running for real, with `isGitAuthError` still
// classifying the failure.
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
  resolveProjectCredential,
} from '#domain/projects'
import { closeDb } from '#db'
import {
  projectDir,
  repoDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '@yaac/shared/project-paths'
import {
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
  PLACEHOLDER_ACCESS_TOKEN,
} from '@yaac/shared/tool-auth'
import type { ProjectMeta } from '@yaac/shared/types'

const mockClone = vi.mocked(cloneRepo)

let tmpDir: string
/** A token credential every case may clone with. */
let token: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  token = (await addHttpsCredential({ name: 'default', token: 'ghp_default' })).id
  mockClone.mockReset()
  // A successful clone leaves a repo behind; mirror that so the rollback
  // cases have something real to remove.
  mockClone.mockImplementation(async (_url, dest) => {
    await fs.mkdir(path.join(dest, '.git'), { recursive: true })
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function readMeta(slug: string): Promise<ProjectMeta> {
  return JSON.parse(
    await fs.readFile(path.join(projectDir(slug), 'project.json'), 'utf8'),
  ) as ProjectMeta
}

describe('addProject', () => {
  it('clones with the credential it is given and records the project with it', async () => {
    const { id } = await addHttpsCredential({ name: 'gh', token: 'ghp_secret' })

    const { project, knownHostsEntry } = await addProject('https://github.com/acme/Widgets.git', id)

    // The slug is baked into image tags, which podman requires lowercase.
    expect(project.slug).toBe('widgets')
    expect(project.remoteUrl).toBe('https://github.com/acme/Widgets.git')
    expect(Date.parse(project.addedAt)).not.toBeNaN()
    expect(await readMeta('widgets')).toEqual(project)

    expect(mockClone).toHaveBeenCalledWith(
      'https://github.com/acme/Widgets.git',
      repoDir('widgets'),
      { kind: 'https', token: 'ghp_secret' },
    )
    expect(knownHostsEntry).toBeNull()
    expect(await resolveProjectCredential('widgets')).toEqual({ kind: 'https', token: 'ghp_secret' })
  })

  it('clones an SCP-style remote with an ssh key, trusting the host key it fetched', async () => {
    const key = await generateSshCredential({ name: 'deploy' })

    const { project, knownHostsEntry } = await addProject(
      'git@git.example.com:group/sub/Repo.git', key.id,
    )

    expect(project.slug).toBe('repo')
    expect(knownHostsEntry).toBe(HOST_KEY)
    // The clone is handed the public halves only: the agent signs.
    const credential = { kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY }
    expect(mockClone).toHaveBeenCalledWith('git@git.example.com:group/sub/Repo.git', repoDir('repo'), credential)
    expect(await resolveProjectCredential('repo')).toEqual(credential)
  })

  it('refuses a credential of the wrong kind, or none that exists, before cloning', async () => {
    await expect(addProject('git@github.com:acme/repo.git', token))
      .rejects.toThrow(/needs an SSH key, not a token/)
    await expect(addProject('https://github.com/acme/repo.git', '00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClone).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
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

    await addProject('https://github.com/acme/repo.git', token)

    // Placeholders, never the real tokens — the proxy swaps them per request.
    const claude = JSON.parse(
      await fs.readFile(projectClaudeCredentialsFile('repo'), 'utf8'),
    ) as { claudeAiOauth: { accessToken: string } }
    expect(claude.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)

    const codex = JSON.parse(await fs.readFile(projectCodexAuthFile('repo'), 'utf8')) as {
      tokens: { access_token: string }
    }
    expect(codex.tokens.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('leaves the tool credential dirs empty when the user has no oauth login', async () => {
    await addProject('https://github.com/acme/repo.git', token)

    await expect(fs.access(projectClaudeCredentialsFile('repo'))).rejects.toThrow()
    await expect(fs.access(projectCodexAuthFile('repo'))).rejects.toThrow()
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
      await expect(addProject(bad, token)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(mockClone).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing project', async () => {
    await addProject('https://github.com/acme/repo.git', token)

    await expect(addProject('https://github.com/other/repo.git', token))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    // The first project's remote is untouched.
    expect((await readMeta('repo')).remoteUrl).toBe('https://github.com/acme/repo.git')
  })

  it('maps a rejected credential to VALIDATION and rolls the project dir back', async () => {
    const { id } = await addHttpsCredential({ name: 'gh', token: 'ghp_stale' })
    mockClone.mockRejectedValue(new Error('fatal: Authentication failed for https://github.com/'))

    const attempt = addProject('https://github.com/acme/repo.git', id)
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(attempt).rejects.toThrow(/git authentication failed for github\.com/)
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
  })

  it('maps any other clone failure to INTERNAL and rolls the project dir back', async () => {
    mockClone.mockRejectedValue(new Error('fatal: repository not found'))

    const attempt = addProject('https://github.com/acme/repo.git', token)
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/Failed to clone: fatal: repository not found/)
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
  })
})
