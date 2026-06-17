import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  buildFakeClaudeOAuthBundle,
  seedFakeClaudeOAuth,
  seedFakeGithubCredential,
  FAKE_GITHUB_PATTERN,
  FAKE_GITHUB_TOKEN,
} from '@/lib/project/fake-auth'
import { loadClaudeCredentialsFile } from '@/lib/project/tool-auth'
import { loadCredentials, saveCredentials } from '@/lib/project/credentials'
import {
  projectDir,
  claudeDir,
  projectClaudeCredentialsFile,
} from '@/lib/project/paths'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@/lib/project/tool-auth'

describe('fake-auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('buildFakeClaudeOAuthBundle', () => {
    it('uses the proxy placeholder tokens so the credential chains through a parent', () => {
      const bundle = buildFakeClaudeOAuthBundle()
      expect(bundle.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(bundle.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
    })

    it('sets a future expiry so Claude Code does not refresh on first use', () => {
      const bundle = buildFakeClaudeOAuthBundle()
      expect(bundle.expiresAt).toBeGreaterThan(Date.now())
    })

    it('carries plausible scopes and subscription type', () => {
      const bundle = buildFakeClaudeOAuthBundle()
      expect(bundle.scopes).toContain('user:inference')
      expect(bundle.subscriptionType).toBe('max')
    })
  })

  describe('seedFakeClaudeOAuth', () => {
    it('writes an OAuth credential (not api-key) to the data dir', async () => {
      await seedFakeClaudeOAuth()
      const creds = await loadClaudeCredentialsFile()
      expect(creds?.kind).toBe('oauth')
      expect(creds?.kind === 'oauth' && creds.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    })

    it('fans the placeholder bundle out to existing projects', async () => {
      await fs.mkdir(claudeDir('demo'), { recursive: true })
      await fs.mkdir(projectDir('demo'), { recursive: true })
      await seedFakeClaudeOAuth()
      const raw = await fs.readFile(projectClaudeCredentialsFile('demo'), 'utf8')
      const parsed = JSON.parse(raw) as { claudeAiOauth: { accessToken: string } }
      expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    })
  })

  describe('seedFakeGithubCredential', () => {
    it('writes an https github.com/* entry to the data dir', async () => {
      await seedFakeGithubCredential()
      const creds = await loadCredentials()
      expect(creds.tokens).toContainEqual({
        kind: 'https',
        pattern: FAKE_GITHUB_PATTERN,
        token: FAKE_GITHUB_TOKEN,
      })
    })

    it('replaces only the matching pattern, preserving other entries', async () => {
      await saveCredentials({
        tokens: [{ kind: 'https', pattern: 'gitlab.com/*', token: 'keep-me' }],
      })
      await seedFakeGithubCredential()
      const creds = await loadCredentials()
      expect(creds.tokens).toContainEqual({
        kind: 'https',
        pattern: 'gitlab.com/*',
        token: 'keep-me',
      })
      expect(creds.tokens).toContainEqual({
        kind: 'https',
        pattern: FAKE_GITHUB_PATTERN,
        token: FAKE_GITHUB_TOKEN,
      })
    })
  })
})
