import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { assignRepoCredential, resolveRepoCredential } from '#domain/repos'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { listAuth, seedFakeAuth } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getRepo, getToolCredential, recordProject, setToolCredential } from '#db'
import { buildFakeClaudeOAuthBundle } from '#domain/auth/fake-auth'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_OMP_API_KEY,
  PLACEHOLDER_OPENCODE_API_KEY,
  PLACEHOLDER_PI_API_KEY,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@yaac/shared/tool-auth'
import { projectClaudeCredentialsFile } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

// Workspaces sandboxed, as under k8s; a test wanting containerless
// installs its own.
beforeEach(() => { installFakeWorkspaceDriver() })

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'
const ME = BUILT_IN_USER_ID

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('seedFakeAuth', () => {
  it('seeds claude as an OAuth bundle of proxy placeholders, expiring far out', async () => {
    // OAuth, not api-key: only an OAuth token can chain through a parent
    // yaac's MITM proxy, which swaps the sentinels for the real credential.
    await seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)

    const creds = await getToolCredential(ME, 'claude')
    expect(creds?.kind).toBe('oauth')
    if (creds?.kind !== 'oauth') throw new Error('unreachable')
    expect(creds.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    expect(creds.claudeAiOauth.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
    // Far enough out that Claude Code won't try to refresh on first use.
    expect(creds.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now())
    expect(creds.claudeAiOauth.scopes).toContain('user:inference')
    expect(creds.claudeAiOauth.subscriptionType).toBe('max')
  })

  it('fans the claude bundle out to the user\'s projects added before the seed', async () => {
    await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', addedAt: 'x' }, ME)

    await seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)

    const parsed = JSON.parse(
      await fs.readFile(projectClaudeCredentialsFile(DEMO_PROJECT_ID), 'utf8'),
    ) as { claudeAiOauth: { accessToken: string } }
    expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('seeds opencode, pi and omp as OpenRouter api-keys holding their own placeholders, again over its own fake', async () => {
    await seedFakeAuth(['opencode-openrouter', 'pi-openrouter', 'omp-openrouter'], BUILT_IN_USER_ID)
    await seedFakeAuth(['opencode-openrouter', 'pi-openrouter', 'omp-openrouter'], BUILT_IN_USER_ID)

    for (const [creds, placeholder] of [
      [await getToolCredential(ME, 'opencode'), PLACEHOLDER_OPENCODE_API_KEY],
      [await getToolCredential(ME, 'pi'), PLACEHOLDER_PI_API_KEY],
      [await getToolCredential(ME, 'omp'), PLACEHOLDER_OMP_API_KEY],
    ] as const) {
      expect(creds?.kind).toBe('api-key')
      expect(creds?.provider).toBe('openrouter')
      expect(creds?.apiKey).toBe(placeholder)
      expect(typeof creds?.savedAt).toBe('string')
    }
  })

  it('seeds github with the placeholder this workspace\'s own GH_TOKEN holds', async () => {
    const placeholder = `${PLACEHOLDER_GH_TOKEN}-7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d`
    vi.stubEnv('GH_TOKEN', placeholder)
    await seedFakeAuth(['github'], BUILT_IN_USER_ID)
    expect((await listAuth(BUILT_IN_USER_ID)).gitCredentials[0]?.preview).toBe(`***${placeholder.slice(-4)}`)
  })

  it('seeds github as the fake-github token credential, once', async () => {
    // A real token is never copied into the fake credential.
    vi.stubEnv('GH_TOKEN', 'ghp_real')
    await seedFakeAuth(['github'], BUILT_IN_USER_ID)
    await seedFakeAuth(['github'], BUILT_IN_USER_ID)

    const listing = (await listAuth(BUILT_IN_USER_ID)).gitCredentials
    expect(listing).toEqual([{
      id: expect.any(String) as string,
      name: 'fake-github',
      kind: 'https',
      preview: `***${PLACEHOLDER_GH_TOKEN.slice(-4)}`,
      repos: [],
    }])
    // A project added with it clones with the placeholder a parent proxy swaps.
    await recordTestProject(WEB, { remoteUrl: 'https://github.com/acme/web' })
    await assignRepoCredential(local, WEB, listing[0].id)
    expect(await resolveRepoCredential((await getRepo(WEB))!)).toEqual({ kind: 'https', token: PLACEHOLDER_GH_TOKEN })
  })

  it('refuses, seeding nothing, over a real credential — and re-seeds over a fake', async () => {
    await seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)
    await seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)

    await setToolCredential(ME, 'opencode', {
      kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or-real',
    })
    await expect(seedFakeAuth(['pi-openrouter', 'opencode-openrouter'], BUILT_IN_USER_ID))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('opencode-openrouter') as string })
    // All or nothing: pi was not seeded alongside the refusal.
    expect(await getToolCredential(ME, 'pi')).toBeNull()
    expect((await getToolCredential(ME, 'opencode'))?.apiKey).toBe('sk-or-real')

    await setToolCredential(ME, 'claude', {
      kind: 'oauth', savedAt: 'x', claudeAiOauth: { ...buildFakeClaudeOAuthBundle(), accessToken: 'sk-ant-oat-real' },
    })
    await expect(seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)).rejects.toMatchObject({ code: 'CONFLICT' })
    const creds = await getToolCredential(ME, 'claude')
    expect(creds?.kind === 'oauth' && creds.claudeAiOauth.accessToken).toBe('sk-ant-oat-real')
  })
})
