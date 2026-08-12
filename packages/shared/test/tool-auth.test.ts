import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { loadCredentials, saveCredentials } from '@yaac/server/domain/projects/credentials'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  credentialsDir,
  opencodeCredentialsPath,
  piCredentialsPath,
  projectClaudeCredentialsFile,
  claudeDir,
  projectDir,
} from '#project-paths'
import {
  loadToolAuthEntry,
  saveToolAuth,
  saveClaudeOAuthBundle,
  saveClaudeCredentialsFile,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  loadOpencodeCredentialsFile,
  loadPiCredentialsFile,
  removeToolAuth,
  buildPlaceholderBundle,
  writeProjectClaudePlaceholder,
  fanOutClaudePlaceholders,
  persistToolAuthPayload,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '#tool-auth'
import {
  claudeKeychainService,
  detectAuthKind,
  extractClaudeOAuthBundle,
} from '#tool-auth-interactive'
import { ServerError } from '#errors'
import type { AgentTool, ClaudeOAuthBundle, CodexOAuthBundle } from '#types'

const SAMPLE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9999999999999,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'pro',
}

/**
 * Capture a rejected ServerError so assertions can read `code` and `message`
 * directly — asymmetric matchers inside `toMatchObject` type as `any` and trip
 * no-unsafe-assignment.
 */
async function rejection(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p
  } catch (err) {
    return err as ServerError
  }
  throw new Error('expected a rejection, got success')
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
      })
    })

    it('returns an api-key entry for Claude when kind is api-key', async () => {
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      const entry = await loadToolAuthEntry('claude')
      expect(entry).toMatchObject({ tool: 'claude', kind: 'api-key', apiKey: 'sk-ant-api03-xyz' })
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

    it('leaves git credentials untouched', async () => {
      await saveCredentials({ tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_test' }] })
      await saveToolAuth('claude', 'sk-ant-api03-xyz', 'api-key')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ kind: 'https', pattern: 'github.com/*', token: 'ghp_test' }])
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
      ).rejects.toBeInstanceOf(ServerError)
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

  describe('opencode (OpenRouter / NeuralWatt)', () => {
    it('detectAuthKind always returns api-key for opencode', () => {
      expect(detectAuthKind('opencode', 'sk-or-anything')).toBe('api-key')
      expect(detectAuthKind('opencode', 'sk-ant-oat01-claude-looking')).toBe('api-key')
    })

    it('persists an opencode api-key and round-trips through loadToolAuthEntry', async () => {
      await persistToolAuthPayload('opencode', {
        kind: 'api-key',
        apiKey: 'sk-or-v1-roundtrip',
        provider: 'openrouter',
      })
      const entry = await loadToolAuthEntry('opencode')
      expect(entry).toMatchObject({
        tool: 'opencode',
        kind: 'api-key',
        apiKey: 'sk-or-v1-roundtrip',
        // The provider is recorded as given — never inferred.
        opencodeProvider: 'openrouter',
      })
      expect(typeof entry?.savedAt).toBe('string')
    })

    it('persists the neuralwatt provider from the payload', async () => {
      await persistToolAuthPayload('opencode', {
        kind: 'api-key',
        apiKey: 'nw-key',
        provider: 'neuralwatt',
      })
      const entry = await loadToolAuthEntry('opencode')
      expect(entry).toMatchObject({
        tool: 'opencode',
        kind: 'api-key',
        apiKey: 'nw-key',
        opencodeProvider: 'neuralwatt',
      })
      const file = await loadOpencodeCredentialsFile()
      expect(file?.provider).toBe('neuralwatt')
    })

    it('saveToolAuth records the opencode provider', async () => {
      await saveToolAuth('opencode', 'nw-direct', 'api-key', 'neuralwatt')
      expect((await loadToolAuthEntry('opencode'))?.opencodeProvider).toBe('neuralwatt')
    })

    it('treats creds without the provider field as unconfigured', async () => {
      // A credential file written before `provider` existed. Save once to
      // create the credentials dir, then overwrite with the legacy shape.
      // Inferring openrouter would scope the key to a vendor it may not
      // belong to, so the file is unusable until `yaac auth` rewrites it.
      await saveToolAuth('opencode', 'sk-or-legacy', 'api-key', 'openrouter')
      await fs.writeFile(
        opencodeCredentialsPath(),
        JSON.stringify({ kind: 'api-key', savedAt: '2025-01-01T00:00:00.000Z', apiKey: 'sk-or-legacy' }),
      )
      expect(await loadOpencodeCredentialsFile()).toBeNull()
      expect(await loadToolAuthEntry('opencode')).toBeNull()
    })

    it('loadToolAuthEntry returns null when no opencode creds are saved', async () => {
      expect(await loadToolAuthEntry('opencode')).toBeNull()
    })

    it('removeToolAuth deletes opencode credentials and returns true', async () => {
      await persistToolAuthPayload('opencode', { kind: 'api-key', apiKey: 'sk-or-rm', provider: 'openrouter' })
      expect(await removeToolAuth('opencode')).toBe(true)
      expect(await loadToolAuthEntry('opencode')).toBeNull()
    })

    it('removeToolAuth returns false when no opencode creds exist', async () => {
      expect(await removeToolAuth('opencode')).toBe(false)
    })

    it('rejects an opencode write with a missing or unknown provider', async () => {
      const missing = await rejection(saveToolAuth('opencode', 'sk-x', 'api-key'))
      expect(missing.code).toBe('VALIDATION')
      expect(missing.message).toContain('require a provider')
      const unknown = await rejection(saveToolAuth('opencode', 'sk-x', 'api-key', 'not-a-provider'))
      expect(unknown.code).toBe('VALIDATION')
      await expect(persistToolAuthPayload('opencode', { kind: 'api-key', apiKey: 'sk-x', provider: 'nope' }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects an oauth payload for opencode (api-key only)', async () => {
      await expect(
        persistToolAuthPayload('opencode', {
          kind: 'oauth',
          bundle: { accessToken: 'x', refreshToken: 'y', expiresAt: 1, scopes: [] },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('pi (OpenRouter / Anthropic / OpenAI)', () => {
    it('detectAuthKind always returns api-key for pi', () => {
      expect(detectAuthKind('pi', 'sk-or-anything')).toBe('api-key')
      expect(detectAuthKind('pi', 'sk-ant-oat01-claude-looking')).toBe('api-key')
    })

    it('persists a pi api-key and round-trips through loadToolAuthEntry', async () => {
      await persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-or-pi-roundtrip', provider: 'openrouter' })
      const entry = await loadToolAuthEntry('pi')
      expect(entry).toMatchObject({
        tool: 'pi',
        kind: 'api-key',
        apiKey: 'sk-or-pi-roundtrip',
        // The provider is recorded as given — never inferred.
        piProvider: 'openrouter',
      })
      expect(typeof entry?.savedAt).toBe('string')
    })

    it('persists the anthropic provider from the payload', async () => {
      await persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-ant-key', provider: 'anthropic' })
      const entry = await loadToolAuthEntry('pi')
      expect(entry).toMatchObject({ tool: 'pi', kind: 'api-key', apiKey: 'sk-ant-key', piProvider: 'anthropic' })
      expect((await loadPiCredentialsFile())?.provider).toBe('anthropic')
    })

    it('persists the openai provider from the payload', async () => {
      await persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-oai-key', provider: 'openai' })
      expect((await loadToolAuthEntry('pi'))?.piProvider).toBe('openai')
    })

    it('saveToolAuth records the pi provider', async () => {
      await saveToolAuth('pi', 'sk-ant-direct', 'api-key', 'anthropic')
      expect((await loadToolAuthEntry('pi'))?.piProvider).toBe('anthropic')
    })

    it('treats a stored provider the registry no longer carries as unconfigured', async () => {
      // Coercing it to the default would seed this key under openrouter's env
      // var and inject it on openrouter's host — a key the user scoped to
      // another vendor. Reading it as "not configured" is the safe repair
      // path: `yaac auth` re-records a provider that still exists.
      await saveToolAuth('pi', 'sk-or-legacy', 'api-key', 'openrouter')
      await fs.writeFile(
        piCredentialsPath(),
        JSON.stringify({ kind: 'api-key', savedAt: '2025-01-01T00:00:00.000Z', apiKey: 'sk-or-legacy', provider: 'neuralwatt' }),
      )
      expect(await loadPiCredentialsFile()).toBeNull()
      expect(await loadToolAuthEntry('pi')).toBeNull()
    })

    it('treats a credential file written before the provider field as unconfigured', async () => {
      await saveToolAuth('pi', 'sk-or-legacy', 'api-key', 'openrouter') // creates the credentials dir
      await fs.writeFile(
        piCredentialsPath(),
        JSON.stringify({ kind: 'api-key', savedAt: '2025-01-01T00:00:00.000Z', apiKey: 'sk-or-legacy' }),
      )
      expect(await loadPiCredentialsFile()).toBeNull()
    })

    it('rejects a write naming an unknown provider', async () => {
      // neuralwatt is an opencode provider — known, but not to pi.
      await expect(saveToolAuth('pi', 'sk-x', 'api-key', 'neuralwatt'))
        .rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-x', provider: 'nope' }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects a write with no provider, naming the repair', async () => {
      const missing = await rejection(saveToolAuth('pi', 'sk-x', 'api-key'))
      expect(missing.code).toBe('VALIDATION')
      expect(missing.message).toContain('require a provider')
      const viaWire = await rejection(persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-x' }))
      expect(viaWire.message).toContain('yaac auth update pi')
    })

    it('truncates the rejected provider value so a mis-pasted key cannot land in the message', async () => {
      const misPasted = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
      const err = await rejection(saveToolAuth('pi', 'sk-x', 'api-key', misPasted))
      expect(err.message).not.toContain(misPasted)
      expect(err.message).toContain('…')
    })

    it('loadToolAuthEntry returns null when no pi creds are saved', async () => {
      expect(await loadToolAuthEntry('pi')).toBeNull()
    })

    it('removeToolAuth deletes pi credentials and returns true', async () => {
      await persistToolAuthPayload('pi', { kind: 'api-key', apiKey: 'sk-or-rm', provider: 'openrouter' })
      expect(await removeToolAuth('pi')).toBe(true)
      expect(await loadToolAuthEntry('pi')).toBeNull()
    })

    it('removeToolAuth returns false when no pi creds exist', async () => {
      expect(await removeToolAuth('pi')).toBe(false)
    })

    it('rejects an oauth payload for pi (api-key only)', async () => {
      await expect(
        persistToolAuthPayload('pi', {
          kind: 'oauth',
          bundle: { accessToken: 'x', refreshToken: 'y', expiresAt: 1, scopes: [] },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('credential file writes', () => {
    it('never exposes a torn file to a concurrent reader', async () => {
      // These files are read continuously while they are rewritten — the
      // plan-usage poller, session registration, `yaac auth update`. A
      // non-atomic write truncates in place, so an interleaved reader sees
      // an empty file and concludes there are no credentials (which reset
      // the plan-usage poller mid-refresh and made its test flaky).
      const bundle = (token: string): ClaudeOAuthBundle => ({
        accessToken: token,
        refreshToken: `ref-${token}`,
        expiresAt: 4_102_444_800_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      })
      await saveClaudeCredentialsFile({
        kind: 'oauth', savedAt: '2026-07-09T00:00:00.000Z', claudeAiOauth: bundle('tok-0'),
      })

      const writes = Array.from({ length: 40 }, (_, i) =>
        saveClaudeCredentialsFile({
          kind: 'oauth',
          savedAt: '2026-07-09T00:00:00.000Z',
          claudeAiOauth: bundle(`tok-${i + 1}`),
        }))
      const reads = Array.from({ length: 200 }, () => loadClaudeCredentialsFile())
      const [, ...results] = await Promise.all([Promise.all(writes), ...reads])

      // Every read landed on a complete file — some old value, some new,
      // never null.
      expect(results.every((r) => r?.kind === 'oauth')).toBe(true)
    })

    it('leaves no temp file behind', async () => {
      await saveClaudeCredentialsFile({
        kind: 'api-key', savedAt: '2026-07-09T00:00:00.000Z', apiKey: 'sk-test',
      })
      const entries = await fs.readdir(credentialsDir())
      expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([])
    })
  })
})
