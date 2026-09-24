import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { assignProjectCredential, listCredentialSummaries, resolveProjectCredential, seedFakeAuth } from '#domain/projects'
import { closeDb, recordProject } from '#db'
import {
  loadClaudeCredentialsFile,
  loadOpencodeCredentialsFile,
  loadPiCredentialsFile,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@yaac/shared/tool-auth'
import { projectDir, claudeDir, projectClaudeCredentialsFile } from '@yaac/shared/project-paths'

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
    await seedFakeAuth('claude-oauth')

    const creds = await loadClaudeCredentialsFile()
    expect(creds?.kind).toBe('oauth')
    if (creds?.kind !== 'oauth') throw new Error('unreachable')
    expect(creds.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    expect(creds.claudeAiOauth.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
    // Far enough out that Claude Code won't try to refresh on first use.
    expect(creds.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now())
    expect(creds.claudeAiOauth.scopes).toContain('user:inference')
    expect(creds.claudeAiOauth.subscriptionType).toBe('max')
  })

  it('fans the claude bundle out to projects added before the seed', async () => {
    await fs.mkdir(claudeDir('demo'), { recursive: true })
    await fs.mkdir(projectDir('demo'), { recursive: true })

    await seedFakeAuth('claude-oauth')

    const parsed = JSON.parse(
      await fs.readFile(projectClaudeCredentialsFile('demo'), 'utf8'),
    ) as { claudeAiOauth: { accessToken: string } }
    expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('seeds opencode and pi as placeholder OpenRouter api-keys', async () => {
    await seedFakeAuth('opencode-openrouter')
    await seedFakeAuth('pi-openrouter')

    for (const creds of [await loadOpencodeCredentialsFile(), await loadPiCredentialsFile()]) {
      expect(creds?.kind).toBe('api-key')
      expect(creds?.provider).toBe('openrouter')
      expect(creds?.apiKey).toBe(PLACEHOLDER_API_KEY)
      expect(typeof creds?.savedAt).toBe('string')
    }
  })

  it('seeds github as the fake-github token credential, once', async () => {
    await seedFakeAuth('github')
    await seedFakeAuth('github')

    const listing = await listCredentialSummaries()
    expect(listing).toEqual([{
      id: expect.any(String) as string,
      name: 'fake-github',
      kind: 'https',
      preview: `***${PLACEHOLDER_GH_TOKEN.slice(-4)}`,
      projects: [],
    }])
    // A project added with it clones with the placeholder a parent proxy swaps.
    await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'x' })
    await assignProjectCredential('web', listing[0].id)
    expect(await resolveProjectCredential('web')).toEqual({ kind: 'https', token: PLACEHOLDER_GH_TOKEN })
  })
})
