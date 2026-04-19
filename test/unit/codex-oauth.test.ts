import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  codexCredentialsPath,
  codexDir,
  projectCodexAuthFile,
  projectDir,
} from '@/lib/project/paths'
import {
  decodeJwtExp,
  extractCodexOAuthBundle,
  buildCodexPlaceholderBundle,
  writeProjectCodexPlaceholder,
  fanOutCodexPlaceholders,
  saveCodexOAuthBundle,
  saveCodexCredentialsFile,
  loadCodexCredentialsFile,
  loadToolAuthEntry,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@/lib/project/tool-auth'
import type { CodexOAuthBundle } from '@/types'

/**
 * Build a fake JWT with a given `exp` claim (seconds since epoch). Header /
 * signature segments are placeholders — only the payload is meaningful for
 * the tests.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-placeholder`
}

const SAMPLE_EXP_SECONDS = 1_900_000_000 // ~2030-03-17
const SAMPLE_ACCESS_JWT = makeJwt({
  exp: SAMPLE_EXP_SECONDS,
  chatgpt_plan_type: 'plus',
  email: 'user@example.com',
})
const SAMPLE_ID_JWT = makeJwt({
  sub: 'user-123',
  chatgpt_account_id: 'claim-acct',
  email: 'user@example.com',
})

const SAMPLE_BUNDLE: CodexOAuthBundle = {
  accessToken: SAMPLE_ACCESS_JWT,
  refreshToken: 'refresh-token-real',
  idTokenRawJwt: SAMPLE_ID_JWT,
  expiresAt: SAMPLE_EXP_SECONDS * 1000,
  lastRefresh: '2026-04-10T00:00:00.000Z',
  accountId: 'top-level-acct',
}

describe('codex oauth helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('decodeJwtExp', () => {
    it('reads exp from a well-formed JWT', () => {
      expect(decodeJwtExp(SAMPLE_ACCESS_JWT)).toBe(SAMPLE_EXP_SECONDS * 1000)
    })

    it('returns null when exp is missing', () => {
      expect(decodeJwtExp(makeJwt({ sub: 'x' }))).toBeNull()
    })

    it('returns null when exp is not a number', () => {
      expect(decodeJwtExp(makeJwt({ exp: '1234' }))).toBeNull()
    })

    it('returns null for malformed JWTs', () => {
      expect(decodeJwtExp('not.a.jwt.atall')).toBeNull()
      expect(decodeJwtExp('only-one-part')).toBeNull()
      expect(decodeJwtExp('two.parts')).toBeNull()
    })

    it('returns null when payload is not JSON', () => {
      const garbage = 'aGVhZGVy.bm90LWpzb24.c2ln'
      expect(decodeJwtExp(garbage)).toBeNull()
    })
  })

  describe('extractCodexOAuthBundle', () => {
    const NATIVE_AUTH_JSON = {
      OPENAI_API_KEY: null,
      auth_mode: 'ChatGPT',
      tokens: {
        id_token: {
          raw_jwt: SAMPLE_ID_JWT,
          email: 'user@example.com',
          chatgpt_plan_type: 'plus',
          chatgpt_account_id: 'claim-acct',
        },
        access_token: SAMPLE_ACCESS_JWT,
        refresh_token: 'refresh-token-real',
        account_id: 'top-level-acct',
      },
      last_refresh: '2026-04-10T00:00:00.000Z',
    }

    it('parses a native auth.json blob', () => {
      const bundle = extractCodexOAuthBundle(JSON.stringify(NATIVE_AUTH_JSON))
      expect(bundle).toEqual({
        accessToken: SAMPLE_ACCESS_JWT,
        refreshToken: 'refresh-token-real',
        idTokenRawJwt: SAMPLE_ID_JWT,
        expiresAt: SAMPLE_EXP_SECONDS * 1000,
        lastRefresh: '2026-04-10T00:00:00.000Z',
        accountId: 'top-level-acct',
      })
    })

    it('falls back to now+28d when the access_token JWT has no exp', () => {
      const noExpJwt = makeJwt({ sub: 'x' })
      const copy = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, access_token: noExpJwt },
      }
      const before = Date.now()
      const bundle = extractCodexOAuthBundle(JSON.stringify(copy))
      const after = Date.now()
      const windowMs = 28 * 24 * 60 * 60 * 1000
      expect(bundle?.expiresAt).toBeGreaterThanOrEqual(before + windowMs)
      expect(bundle?.expiresAt).toBeLessThanOrEqual(after + windowMs)
    })

    it('returns null when auth_mode is ApiKey', () => {
      const apiKeyMode = { ...NATIVE_AUTH_JSON, auth_mode: 'ApiKey' }
      expect(extractCodexOAuthBundle(JSON.stringify(apiKeyMode))).toBeNull()
    })

    it('returns null when tokens is missing', () => {
      expect(extractCodexOAuthBundle(JSON.stringify({ auth_mode: 'ChatGPT' }))).toBeNull()
    })

    it('returns null when access_token is missing', () => {
      const copy = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, access_token: undefined },
      }
      expect(extractCodexOAuthBundle(JSON.stringify(copy))).toBeNull()
    })

    it('returns null when refresh_token is missing', () => {
      const copy = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, refresh_token: undefined },
      }
      expect(extractCodexOAuthBundle(JSON.stringify(copy))).toBeNull()
    })

    it('returns null when id_token.raw_jwt is missing', () => {
      const copy = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, id_token: { email: 'x' } },
      }
      expect(extractCodexOAuthBundle(JSON.stringify(copy))).toBeNull()
    })

    it('returns null on malformed input', () => {
      expect(extractCodexOAuthBundle('not-json')).toBeNull()
      expect(extractCodexOAuthBundle(JSON.stringify([]))).toBeNull()
      expect(extractCodexOAuthBundle(JSON.stringify('string'))).toBeNull()
    })

    it('accepts missing account_id (undefined field)', () => {
      const copy = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, account_id: undefined },
      }
      const bundle = extractCodexOAuthBundle(JSON.stringify(copy))
      expect(bundle?.accountId).toBeUndefined()
    })

    it('synthesizes last_refresh when absent', () => {
      const copy = { ...NATIVE_AUTH_JSON, last_refresh: undefined }
      const before = new Date().toISOString()
      const bundle = extractCodexOAuthBundle(JSON.stringify(copy))
      expect(bundle?.lastRefresh).toBeTruthy()
      // ISO strings sort lexicographically, so bundle's value is >= before
      expect(bundle!.lastRefresh >= before).toBe(true)
    })
  })

  describe('saveCodexOAuthBundle / loadCodexCredentialsFile', () => {
    it('round-trips the full bundle', async () => {
      await saveCodexOAuthBundle(SAMPLE_BUNDLE)
      const file = await loadCodexCredentialsFile()
      expect(file?.kind).toBe('oauth')
      if (file?.kind !== 'oauth') throw new Error('expected oauth')
      expect(file.codexOauth).toEqual(SAMPLE_BUNDLE)
      expect(file.savedAt).toBeTruthy()
    })

    it('writes with 0600 permissions', async () => {
      await saveCodexOAuthBundle(SAMPLE_BUNDLE)
      const stats = await fs.stat(codexCredentialsPath())
      expect(stats.mode & 0o777).toBe(0o600)
    })

    it('saveCodexCredentialsFile can write an api-key entry', async () => {
      await saveCodexCredentialsFile({
        kind: 'api-key',
        savedAt: new Date().toISOString(),
        apiKey: 'sk-proj-xyz',
      })
      const file = await loadCodexCredentialsFile()
      expect(file).toMatchObject({ kind: 'api-key', apiKey: 'sk-proj-xyz' })
    })

    it('returns null when oauth bundle is missing required fields', async () => {
      await saveCodexCredentialsFile({
        kind: 'oauth',
        savedAt: new Date().toISOString(),
        // @ts-expect-error intentionally invalid
        codexOauth: { accessToken: 'x' },
      })
      expect(await loadCodexCredentialsFile()).toBeNull()
    })
  })

  describe('loadToolAuthEntry for codex oauth', () => {
    it('returns an OAuth entry carrying the full bundle', async () => {
      await saveCodexOAuthBundle(SAMPLE_BUNDLE)
      const entry = await loadToolAuthEntry('codex')
      expect(entry).toMatchObject({
        tool: 'codex',
        kind: 'oauth',
        apiKey: SAMPLE_BUNDLE.accessToken,
        refreshToken: SAMPLE_BUNDLE.refreshToken,
        expiresAt: SAMPLE_BUNDLE.expiresAt,
      })
      expect(entry?.codexBundle).toEqual(SAMPLE_BUNDLE)
    })
  })

  describe('buildCodexPlaceholderBundle', () => {
    it('sentinels only the bearer tokens', () => {
      const ph = buildCodexPlaceholderBundle(SAMPLE_BUNDLE)
      expect(ph.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(ph.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN)
      // Non-secret fields pass through unchanged.
      expect(ph.idTokenRawJwt).toBe(SAMPLE_BUNDLE.idTokenRawJwt)
      expect(ph.expiresAt).toBe(SAMPLE_BUNDLE.expiresAt)
      expect(ph.lastRefresh).toBe(SAMPLE_BUNDLE.lastRefresh)
      expect(ph.accountId).toBe(SAMPLE_BUNDLE.accountId)
    })
  })

  describe('writeProjectCodexPlaceholder', () => {
    it('writes native auth.json shape and round-trips via extractor', async () => {
      await fs.mkdir(projectDir('demo'), { recursive: true })
      await writeProjectCodexPlaceholder('demo', SAMPLE_BUNDLE)
      const raw = await fs.readFile(projectCodexAuthFile('demo'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.OPENAI_API_KEY).toBeNull()
      const tokens = parsed.tokens as Record<string, unknown>
      expect(tokens.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(tokens.refresh_token).toBe(PLACEHOLDER_REFRESH_TOKEN)
      expect((tokens.id_token as Record<string, unknown>).raw_jwt).toBe(SAMPLE_BUNDLE.idTokenRawJwt)
      expect(tokens.account_id).toBe(SAMPLE_BUNDLE.accountId)
      expect(parsed.last_refresh).toBe(SAMPLE_BUNDLE.lastRefresh)
    })

    it('sets auth_mode:"ChatGPT"-compatible shape (no auth_mode required on disk)', async () => {
      // Codex's deserializer infers mode from presence of tokens vs OPENAI_API_KEY.
      // The file we write has OPENAI_API_KEY:null and tokens:{…}, so Codex treats
      // it as ChatGPT-mode. We guard against writing an api-key-style shape.
      await fs.mkdir(projectDir('alpha'), { recursive: true })
      await writeProjectCodexPlaceholder('alpha', SAMPLE_BUNDLE)
      const raw = await fs.readFile(projectCodexAuthFile('alpha'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.tokens).toBeTruthy()
      expect(parsed.OPENAI_API_KEY).toBeNull()
    })

    it('writes with 0600 permissions', async () => {
      await fs.mkdir(projectDir('demo'), { recursive: true })
      await writeProjectCodexPlaceholder('demo', SAMPLE_BUNDLE)
      const stats = await fs.stat(projectCodexAuthFile('demo'))
      expect(stats.mode & 0o777).toBe(0o600)
    })

    it('accepts a bundle with no accountId — writes null at that field', async () => {
      await fs.mkdir(projectDir('no-acct'), { recursive: true })
      const { accountId: _omit, ...rest } = SAMPLE_BUNDLE
      await writeProjectCodexPlaceholder('no-acct', rest)
      const raw = await fs.readFile(projectCodexAuthFile('no-acct'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const tokens = parsed.tokens as Record<string, unknown>
      expect(tokens.account_id).toBeNull()
    })
  })

  describe('fanOutCodexPlaceholders', () => {
    it('seeds every existing project', async () => {
      await fs.mkdir(codexDir('alpha'), { recursive: true })
      await fs.mkdir(codexDir('beta'), { recursive: true })
      await fanOutCodexPlaceholders(SAMPLE_BUNDLE)
      for (const slug of ['alpha', 'beta']) {
        const raw = await fs.readFile(projectCodexAuthFile(slug), 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const tokens = parsed.tokens as Record<string, unknown>
        expect(tokens.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
      }
    })

    it('is a no-op when no projects exist', async () => {
      await fanOutCodexPlaceholders(SAMPLE_BUNDLE)
      // should not throw
    })
  })
})
