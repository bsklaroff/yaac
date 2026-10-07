import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  projectCodexAuthFile,
  projectDir,
} from '#project-paths'
import {
  buildCodexPlaceholderBundle,
  writeProjectCodexPlaceholder,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '#tool-auth'
import { decodeJwtExp, extractCodexOAuthBundle } from '#tool-auth-interactive'
import type { CodexOAuthBundle } from '#types'

/**
 * Build a fake JWT with a given `exp` claim (seconds since epoch). Only the
 * payload is meaningful.
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
      auth_mode: 'chatgpt',
      tokens: {
        id_token: SAMPLE_ID_JWT,
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

    it('accepts "ChatGPT" auth_mode for back-compat with older codex-cli', () => {
      const pascalCase = { ...NATIVE_AUTH_JSON, auth_mode: 'ChatGPT' }
      expect(extractCodexOAuthBundle(JSON.stringify(pascalCase))).not.toBeNull()
    })

    it('returns null when tokens is missing', () => {
      expect(extractCodexOAuthBundle(JSON.stringify({ auth_mode: 'chatgpt' }))).toBeNull()
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

    it('returns null when id_token is missing or not a string', () => {
      const missing = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, id_token: undefined },
      }
      expect(extractCodexOAuthBundle(JSON.stringify(missing))).toBeNull()
      const nested = {
        ...NATIVE_AUTH_JSON,
        tokens: { ...NATIVE_AUTH_JSON.tokens, id_token: { raw_jwt: SAMPLE_ID_JWT } },
      }
      expect(extractCodexOAuthBundle(JSON.stringify(nested))).toBeNull()
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
      expect(parsed.auth_mode).toBe('chatgpt')
      const tokens = parsed.tokens as Record<string, unknown>
      expect(tokens.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(tokens.refresh_token).toBe(PLACEHOLDER_REFRESH_TOKEN)
      expect(tokens.id_token).toBe(SAMPLE_BUNDLE.idTokenRawJwt)
      expect(tokens.account_id).toBe(SAMPLE_BUNDLE.accountId)
      expect(parsed.last_refresh).toBe(SAMPLE_BUNDLE.lastRefresh)
    })

    it('writes auth_mode:"chatgpt" so Codex enters ChatGPT mode', async () => {
      await fs.mkdir(projectDir('alpha'), { recursive: true })
      await writeProjectCodexPlaceholder('alpha', SAMPLE_BUNDLE)
      const raw = await fs.readFile(projectCodexAuthFile('alpha'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.auth_mode).toBe('chatgpt')
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
})
