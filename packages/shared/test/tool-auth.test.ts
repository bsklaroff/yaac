import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  projectClaudeCredentialsFile,
  claudeDir,
  projectDir,
} from '#project-paths'
import {
  buildPlaceholderBundle,
  writeProjectClaudePlaceholder,
  writeProjectClaudeCredentials,
  writeProjectCodexAuth,
  writeProjectCodexPlaceholder,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '#tool-auth'
import {
  claudeKeychainService,
  detectAuthKind,
  extractClaudeOAuthBundle,
} from '#tool-auth-interactive'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '#types'

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

  describe('claudeKeychainService', () => {
    it('is the plain host service without a config dir', () => {
      expect(claudeKeychainService()).toBe('Claude Code-credentials')
    })

    it('suffixes 8 hex chars of sha256(configDir) — matching the CLI', () => {
      // sha256('/tmp/x') = 2e56aa36… — the CLI takes the first 8 hex chars.
      expect(claudeKeychainService('/tmp/x')).toBe('Claude Code-credentials-2e56aa36')
    })

    it('NFC-normalizes the config dir before hashing, like the CLI', () => {
      const composed = '/tmp/caf\u00e9'
      const decomposed = '/tmp/cafe\u0301'
      expect(claudeKeychainService(decomposed)).toBe(claudeKeychainService(composed))
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

  describe('placeholder bundles', () => {
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

  })

  describe('reading back what a project tool home holds', () => {
    const SAMPLE_CODEX: CodexOAuthBundle = {
      accessToken: 'codex-access-real',
      refreshToken: 'codex-refresh-real',
      idTokenRawJwt: 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDB9.',
      expiresAt: 9999999999999,
      lastRefresh: '2026-07-09T00:00:00.000Z',
      accountId: 'acct-1',
    }

    it('round-trips the real bundle a proxyless runtime writes, and reports a sentinel as-is', async () => {
      // A containerless agent refreshes its token in place, so the project
      // home holds the live one.
      await writeProjectClaudeCredentials('demo', SAMPLE_BUNDLE)
      expect(await readProjectClaudeBundle('demo')).toEqual(SAMPLE_BUNDLE)
      expect(isPlaceholderClaudeBundle(SAMPLE_BUNDLE)).toBe(false)

      // A sentinel is reported, not filtered: seeding needs to see that a
      // project holds one.
      await writeProjectClaudePlaceholder('demo', SAMPLE_BUNDLE)
      const placeholder = await readProjectClaudeBundle('demo')
      expect(placeholder?.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(isPlaceholderClaudeBundle(placeholder as ClaudeOAuthBundle)).toBe(true)

      await writeProjectCodexAuth('demo', SAMPLE_CODEX)
      expect(await readProjectCodexBundle('demo')).toMatchObject({
        accessToken: SAMPLE_CODEX.accessToken,
        refreshToken: SAMPLE_CODEX.refreshToken,
        accountId: SAMPLE_CODEX.accountId,
      })
      await writeProjectCodexPlaceholder('demo', SAMPLE_CODEX)
      const codexPlaceholder = await readProjectCodexBundle('demo')
      expect(isPlaceholderCodexBundle(codexPlaceholder as CodexOAuthBundle)).toBe(true)
    })

    it('reads null for a project with no credential, and for an unparseable one', async () => {
      expect(await readProjectClaudeBundle('missing')).toBeNull()
      expect(await readProjectCodexBundle('missing')).toBeNull()

      await fs.mkdir(claudeDir('broken'), { recursive: true })
      await fs.writeFile(projectClaudeCredentialsFile('broken'), '{ not json')
      expect(await readProjectClaudeBundle('broken')).toBeNull()
    })

  })

  describe('opencode (OpenRouter / NeuralWatt)', () => {
    it('detectAuthKind always returns api-key for opencode', () => {
      expect(detectAuthKind('opencode', 'sk-or-anything')).toBe('api-key')
      expect(detectAuthKind('opencode', 'sk-ant-oat01-claude-looking')).toBe('api-key')
    })

  })

  describe('pi (OpenRouter / Anthropic / OpenAI)', () => {
    it('detectAuthKind always returns api-key for pi', () => {
      expect(detectAuthKind('pi', 'sk-or-anything')).toBe('api-key')
      expect(detectAuthKind('pi', 'sk-ant-oat01-claude-looking')).toBe('api-key')
    })

  })

  describe('credential file writes', () => {
    it('never exposes a torn file to a concurrent reader', async () => {
      // A project's tool home is read while being rewritten (credential
      // sync, the agent itself). A non-atomic write would let a reader see an
      // empty file and conclude there is no credential.
      const bundle = (token: string): ClaudeOAuthBundle => ({ ...SAMPLE_BUNDLE, accessToken: token })
      await writeProjectClaudeCredentials('demo', bundle('tok-0'))

      const writes = Array.from({ length: 40 }, (_, i) => writeProjectClaudeCredentials('demo', bundle(`tok-${i + 1}`)))
      const reads = Array.from({ length: 200 }, () => readProjectClaudeBundle('demo'))
      const [, ...results] = await Promise.all([Promise.all(writes), ...reads])

      // Every read saw a complete file, old or new, never null, and no temp
      // file is left behind.
      expect(results.every((r) => r !== null)).toBe(true)
      expect((await fs.readdir(claudeDir('demo'))).filter((e) => e.includes('.tmp-'))).toEqual([])
    })

  })
})
