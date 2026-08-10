import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The clone is the one thing this feature shells out for. Faking it (and
// only it) keeps every credential lookup, slug derivation, and rollback
// running for real, with `isGitAuthError` still classifying the failure.
vi.mock('#platform/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  cloneRepo: vi.fn(),
}))

import { cloneRepo } from '#platform/git'
import type * as gitModule from '#platform/git'
import { addProject } from '#domain/projects'
import { addEntry, saveCredentials } from '#store/projects'
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

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockClone.mockReset()
  // A successful clone leaves a repo behind; mirror that so the rollback
  // cases have something real to remove.
  mockClone.mockImplementation(async (_url, dest) => {
    await fs.mkdir(path.join(dest, '.git'), { recursive: true })
  })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

async function readMeta(slug: string): Promise<ProjectMeta> {
  return JSON.parse(
    await fs.readFile(path.join(projectDir(slug), 'project.json'), 'utf8'),
  ) as ProjectMeta
}

describe('addProject', () => {
  it('clones with the matching credential and records the project', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_secret' })

    const { project } = await addProject('https://github.com/acme/Widgets.git')

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
  })

  it('accepts an SCP-style remote against an ssh credential', async () => {
    // Seeded directly: addEntry probes the key with ssh-keygen, which is
    // beside the point here.
    await saveCredentials({ tokens: [{
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: '/keys/id',
      knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
    }] })

    const { project } = await addProject('git@git.example.com:group/sub/Repo.git')

    expect(project.slug).toBe('repo')
    expect(mockClone).toHaveBeenCalledWith(
      'git@git.example.com:group/sub/Repo.git',
      repoDir('repo'),
      { kind: 'ssh', privateKeyPath: '/keys/id', knownHostsEntry: 'git.example.com ssh-ed25519 AAAA' },
    )
  })

  it('seeds the project with placeholder tool credentials when the user has them', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_secret' })
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

    await addProject('https://github.com/acme/repo.git')

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
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_secret' })

    await addProject('https://github.com/acme/repo.git')

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
      await expect(addProject(bad)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(mockClone).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing project', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_secret' })
    await addProject('https://github.com/acme/repo.git')

    await expect(addProject('https://github.com/other/repo.git'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    // The first project's remote is untouched.
    expect((await readMeta('repo')).remoteUrl).toBe('https://github.com/acme/repo.git')
  })

  it('requires a configured credential before cloning', async () => {
    await addEntry({ kind: 'https', pattern: 'gitlab.com/*', token: 'glp_x' })

    await expect(addProject('https://github.com/acme/repo.git'))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(mockClone).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
  })

  it('maps a rejected credential to AUTH_REQUIRED and rolls the project dir back', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_stale' })
    mockClone.mockRejectedValue(new Error('fatal: Authentication failed for https://github.com/'))

    const attempt = addProject('https://github.com/acme/repo.git')
    await expect(attempt).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await expect(attempt).rejects.toThrow(/git authentication failed for github\.com/)
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
  })

  it('maps any other clone failure to INTERNAL and rolls the project dir back', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_secret' })
    mockClone.mockRejectedValue(new Error('fatal: repository not found'))

    const attempt = addProject('https://github.com/acme/repo.git')
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/Failed to clone: fatal: repository not found/)
    await expect(fs.access(projectDir('repo'))).rejects.toThrow()
  })
})
