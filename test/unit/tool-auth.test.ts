import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { loadCredentials, saveCredentials } from '@/lib/project/credentials'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  projectClaudeCredentialsFile,
  claudeDir,
  projectDir,
} from '@/lib/project/paths'
import {
  detectAuthKind,
  loadToolAuthEntry,
  saveToolAuth,
  saveClaudeOAuthBundle,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  removeToolAuth,
  buildPlaceholderBundle,
  writeProjectClaudePlaceholder,
  fanOutClaudePlaceholders,
  extractClaudeOAuthBundle,
  persistToolAuthPayload,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@/lib/project/tool-auth'
import { DaemonError } from '@/lib/daemon/errors'
import type { AgentTool, ClaudeOAuthBundle, CodexOAuthBundle } from '@/types'

const SAMPLE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9999999999999,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'pro',
}

describe('tool-auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('detectAuthKind', () => {
    it('detects Anthropic API key', () => {
      expect(detectAuthKind('claude', 'sk-ant-api03-abc123')).toBe('api-key')
    })

    it('detects Anthropic OAuth token', () => {
      expect(detectAuthKind('claude', 'sk-ant-oat01-xyz789')).toBe('oauth')
    })

    it('defaults to api-key for unknown claude prefix', () => {
      expect(detectAuthKind('claude', 'some-other-token')).toBe('api-key')
    })

    it('defaults to api-key for codex', () => {
      expect(detectAuthKind('codex', 'sk-proj-abc123')).toBe('api-key')
    })
  })

  describe('extractClaudeOAuthBundle', () => {
    it('parses a native Claude credentials blob', () => {
      const raw = JSON.stringify({ claudeAiOauth: SAMPLE_BUNDLE })
      expect(extractClaudeOAuthBundle(raw)).toEqual(SAMPLE_BUNDLE)
    })

    it('returns null for malformed input', () => {
      expect(extractClaudeOAuthBundle('not-json')).toBeNull()
      expect(extractClaudeOAuthBundle(JSON.stringify({}))).toBeNull()
      expect(extractClaudeOAuthBundle(JSON.stringify({ claudeAiOauth: {} }))).toBeNull()
    })
  })

  describe('loadToolAuthEntry', () => {
    it('returns null when no credentials files exist', async () => {
      expect(await loadToolAuthEntry('claude')).toBeNull()
      expect(await loadToolAuthEntry('codex')).toBeNull()
    })

    it('returns an OAuth entry derived from the Claude bundle', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const entry = await loadToolAuthEntry('claude')
      expect(entry).toMatchObject({
        tool: 'claude',
        kind: 'oauth',
        apiKey: SAMPLE_BUNDLE.accessToken,
        refreshToken: SAMPLE_BUNDLE.refreshToken,
        expiresAt: SAMPLE_BUNDLE.expiresAt,
        scopes: SAMPLE_BUNDLE.scopes,
        subscriptionType: SAMPLE_BUNDLE.subscriptionType,
      })
    })

    it('returns an api-key entry for Claude when kind is api-key', async () => {
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      const entry = await loadToolAuthEntry('claude')
      expect(entry).toMatchObject({ tool: 'claude', kind: 'api-key', apiKey: 'sk-ant-api03-xyz' })
      expect(entry?.refreshToken).toBeUndefined()
    })

    it('loads codex entries from codex.json', async () => {
      await saveToolAuth('codex', 'sk-proj-abc', 'api-key')
      const entry = await loadToolAuthEntry('codex')
      expect(entry).toMatchObject({ tool: 'codex', kind: 'api-key', apiKey: 'sk-proj-abc' })
    })

    it('does not cross-contaminate tools', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      expect(await loadToolAuthEntry('codex')).toBeNull()
    })
  })

  describe('saveClaudeOAuthBundle / loadClaudeCredentialsFile', () => {
    it('round-trips the full OAuth bundle', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const file = await loadClaudeCredentialsFile()
      expect(file?.kind).toBe('oauth')
      if (file?.kind !== 'oauth') throw new Error('expected oauth')
      expect(file.claudeAiOauth).toEqual(SAMPLE_BUNDLE)
      expect(file.savedAt).toBeTruthy()
    })

    it('writes with 0600 permissions', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const stats = await fs.stat(claudeCredentialsPath())
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  describe('saveToolAuth (api-key paths)', () => {
    it('stores a Claude api-key under claude.json', async () => {
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      const file = await loadClaudeCredentialsFile()
      expect(file).toMatchObject({ kind: 'api-key', apiKey: 'sk-ant-api03-xyz' })
    })

    it('stores a Codex api-key under codex.json', async () => {
      await saveToolAuth('codex', 'sk-proj-openai', 'api-key')
      const raw = await fs.readFile(codexCredentialsPath(), 'utf8')
      expect(JSON.parse(raw)).toMatchObject({ kind: 'api-key', apiKey: 'sk-proj-openai' })
    })

    it('leaves github tokens untouched', async () => {
      await saveCredentials({ tokens: [{ pattern: '*', token: 'ghp_test' }] })
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: '*', token: 'ghp_test' }])
    })
  })

  describe('removeToolAuth', () => {
    it('removes an existing Claude credentials file', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const removed = await removeToolAuth('claude')
      expect(removed).toBe(true)
      expect(await loadClaudeCredentialsFile()).toBeNull()
    })

    it('returns false when no Claude credentials exist', async () => {
      expect(await removeToolAuth('claude')).toBe(false)
    })

    it('removes codex credentials independently', async () => {
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      await saveToolAuth('codex', 'sk-proj-x', 'api-key')
      await removeToolAuth('claude')
      expect(await loadToolAuthEntry('claude')).toBeNull()
      expect(await loadToolAuthEntry('codex')).not.toBeNull()
    })
  })

  describe('placeholder fan-out', () => {
    it('replaces tokens but keeps expiresAt/scopes', () => {
      const ph = buildPlaceholderBundle(SAMPLE_BUNDLE)
      expect(ph.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(ph.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
      expect(ph.expiresAt).toBe(SAMPLE_BUNDLE.expiresAt)
      expect(ph.scopes).toEqual(SAMPLE_BUNDLE.scopes)
      expect(ph.subscriptionType).toBe(SAMPLE_BUNDLE.subscriptionType)
    })

    it('writes a placeholder .credentials.json into a project claude dir', async () => {
      await fs.mkdir(projectDir('demo'), { recursive: true })
      await writeProjectClaudePlaceholder('demo', SAMPLE_BUNDLE)
      const raw = await fs.readFile(projectClaudeCredentialsFile('demo'), 'utf8')
      const parsed = JSON.parse(raw) as { claudeAiOauth: ClaudeOAuthBundle }
      expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(parsed.claudeAiOauth.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
      expect(parsed.claudeAiOauth.expiresAt).toBe(SAMPLE_BUNDLE.expiresAt)
    })

    it('fans out to every existing project on login', async () => {
      await fs.mkdir(claudeDir('alpha'), { recursive: true })
      await fs.mkdir(claudeDir('beta'), { recursive: true })
      await fanOutClaudePlaceholders(SAMPLE_BUNDLE)
      for (const slug of ['alpha', 'beta']) {
        const raw = await fs.readFile(projectClaudeCredentialsFile(slug), 'utf8')
        const parsed = JSON.parse(raw) as { claudeAiOauth: ClaudeOAuthBundle }
        expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      }
    })

    it('fan-out is a no-op when no projects exist', async () => {
      await fanOutClaudePlaceholders(SAMPLE_BUNDLE)
      // should not throw
    })
  })

  describe('persistToolAuthPayload', () => {
    const SAMPLE_CODEX_BUNDLE: CodexOAuthBundle = {
      accessToken: 'codex-access',
      refreshToken: 'codex-refresh',
      idTokenRawJwt: 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDB9.',
      expiresAt: 9999999999999,
      lastRefresh: '2026-04-20T00:00:00.000Z',
      accountId: 'acct_x',
    }

    it('saves a claude api-key payload', async () => {
      await persistToolAuthPayload('claude', {
        kind: 'api-key',
        apiKey: 'sk-ant-api03-new',
      })
      const entry = await loadToolAuthEntry('claude')
      expect(entry?.kind).toBe('api-key')
      expect(entry?.apiKey).toBe('sk-ant-api03-new')
    })

    it('saves a claude oauth bundle', async () => {
      await persistToolAuthPayload('claude', {
        kind: 'oauth',
        bundle: SAMPLE_BUNDLE,
      })
      const file = await loadClaudeCredentialsFile()
      expect(file?.kind).toBe('oauth')
      if (file?.kind === 'oauth') {
        expect(file.claudeAiOauth.accessToken).toBe(SAMPLE_BUNDLE.accessToken)
      }
    })

    it('saves a codex oauth bundle', async () => {
      await persistToolAuthPayload('codex', {
        kind: 'oauth',
        bundle: SAMPLE_CODEX_BUNDLE,
      })
      const file = await loadCodexCredentialsFile()
      expect(file?.kind).toBe('oauth')
      if (file?.kind === 'oauth') {
        expect(file.codexOauth.refreshToken).toBe('codex-refresh')
      }
    })

    it('rejects an unknown tool', async () => {
      await expect(
        persistToolAuthPayload('gemini' as unknown as AgentTool, { kind: 'api-key', apiKey: 'x' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects a non-object payload', async () => {
      await expect(
        persistToolAuthPayload('claude', null),
      ).rejects.toBeInstanceOf(DaemonError)
    })

    it('rejects api-key with an empty key', async () => {
      await expect(
        persistToolAuthPayload('claude', { kind: 'api-key', apiKey: '' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects an oauth payload with a malformed bundle', async () => {
      await expect(
        persistToolAuthPayload('claude', { kind: 'oauth', bundle: { accessToken: 'x' } }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects an unknown kind', async () => {
      await expect(
        persistToolAuthPayload('claude', { kind: 'mystery' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})
