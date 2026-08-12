import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { listEntries, saveCredentials, seedFakeAuth } from '#domain/projects'
// The pattern `auth fake github` claims. Not under test here.
import { FAKE_GITHUB_PATTERN } from '#domain/projects/fake-auth'
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

  it('seeds github as a placeholder token, replacing only its own pattern', async () => {
    await saveCredentials({
      tokens: [
        { kind: 'https', pattern: 'gitlab.com/*', token: 'keep-me' },
        { kind: 'https', pattern: FAKE_GITHUB_PATTERN, token: 'stale' },
      ],
    })

    await seedFakeAuth('github')

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'gitlab.com/*', preview: '***p-me' },
      { kind: 'https', pattern: FAKE_GITHUB_PATTERN, preview: `***${PLACEHOLDER_GH_TOKEN.slice(-4)}` },
    ])
  })
})
