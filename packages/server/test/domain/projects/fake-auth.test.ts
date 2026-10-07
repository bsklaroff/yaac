import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { assignProjectCredential, listCredentialSummaries, resolveProjectCredential, seedFakeAuth } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, recordProject, setToolCredential } from '#db'
import { buildFakeClaudeOAuthBundle } from '#domain/projects/fake-auth'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_OPENCODE_API_KEY,
  PLACEHOLDER_PI_API_KEY,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@yaac/shared/tool-auth'
import { projectClaudeCredentialsFile } from '@yaac/shared/project-paths'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'
const ME = BUILT_IN_USER_ID

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
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
    await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', remoteUrl: 'https://github.com/acme/demo', addedAt: 'x' }, ME)

    await seedFakeAuth(['claude-oauth'], BUILT_IN_USER_ID)

    const parsed = JSON.parse(
      await fs.readFile(projectClaudeCredentialsFile(DEMO_PROJECT_ID), 'utf8'),
    ) as { claudeAiOauth: { accessToken: string } }
    expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('seeds opencode and pi as OpenRouter api-keys holding their own placeholders, over an older fake', async () => {
    // A fake from before each tool had its own placeholder is still a fake.
    await setToolCredential(ME, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: PLACEHOLDER_API_KEY })
    await seedFakeAuth(['opencode-openrouter', 'pi-openrouter'], BUILT_IN_USER_ID)

    for (const [creds, placeholder] of [
      [await getToolCredential(ME, 'opencode'), PLACEHOLDER_OPENCODE_API_KEY],
      [await getToolCredential(ME, 'pi'), PLACEHOLDER_PI_API_KEY],
    ] as const) {
      expect(creds?.kind).toBe('api-key')
      expect(creds?.provider).toBe('openrouter')
      expect(creds?.apiKey).toBe(placeholder)
      expect(typeof creds?.savedAt).toBe('string')
    }
  })

  it('seeds github as the fake-github token credential, once', async () => {
    await seedFakeAuth(['github'], BUILT_IN_USER_ID)
    await seedFakeAuth(['github'], BUILT_IN_USER_ID)

    const listing = await listCredentialSummaries(BUILT_IN_USER_ID)
    expect(listing).toEqual([{
      id: expect.any(String) as string,
      name: 'fake-github',
      kind: 'https',
      preview: `***${PLACEHOLDER_GH_TOKEN.slice(-4)}`,
      projects: [],
    }])
    // A project added with it clones with the placeholder a parent proxy swaps.
    await recordProject({ id: WEB, name: 'demo', remoteUrl: 'https://github.com/acme/web', addedAt: 'x' }, BUILT_IN_USER_ID)
    await assignProjectCredential(local, WEB, listing[0].id)
    expect(await resolveProjectCredential(WEB)).toEqual({ kind: 'https', token: PLACEHOLDER_GH_TOKEN })
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
