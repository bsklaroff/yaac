import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Tests for Codex-OAuth-specific proxy helpers. These mirror the logic in
 * podman/proxy-sidecar/proxy.ts — the proxy is bundled separately, so we
 * can't import from it directly. The duplication is acceptable because the
 * functions are small, pure, and fully specified by the tests.
 */

const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

type CodexOAuthBundle = {
  accessToken: string
  refreshToken: string
  idTokenRawJwt: string
  expiresAt: number
  lastRefresh: string
  accountId?: string
}

type CodexCreds =
  | { kind: 'oauth'; bundle: CodexOAuthBundle }
  | { kind: 'api-key'; apiKey: string }

function readCodexCreds(credsFile: string): CodexCreds | null {
  try {
    const raw = fs.readFileSync(credsFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && o.codexOauth && typeof o.codexOauth === 'object') {
      const b = o.codexOauth as Record<string, unknown>
      if (typeof b.accessToken === 'string' && b.accessToken
        && typeof b.refreshToken === 'string' && b.refreshToken
        && typeof b.idTokenRawJwt === 'string' && b.idTokenRawJwt
        && typeof b.expiresAt === 'number'
        && typeof b.lastRefresh === 'string') {
        const bundle: CodexOAuthBundle = {
          accessToken: b.accessToken,
          refreshToken: b.refreshToken,
          idTokenRawJwt: b.idTokenRawJwt,
          expiresAt: b.expiresAt,
          lastRefresh: b.lastRefresh,
          accountId: typeof b.accountId === 'string' ? b.accountId : undefined,
        }
        return { kind: 'oauth', bundle }
      }
      return null
    }
    if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
      return { kind: 'api-key', apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

function writeCodexOAuthBundle(credsFile: string, bundle: CodexOAuthBundle): void {
  const payload = {
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    codexOauth: bundle,
  }
  const tmp = credsFile + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, credsFile)
}

function decodeJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return null
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number') return null
    return exp * 1000
  } catch {
    return null
  }
}

function bodyHasPlaceholderRefreshToken(body: Buffer, contentType: string | undefined): boolean {
  if (body.length === 0) return false
  const bodyStr = body.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(bodyStr)
      if (parsed && typeof parsed === 'object') {
        const rt = (parsed as Record<string, unknown>).refresh_token
        return rt === PLACEHOLDER_REFRESH_TOKEN
      }
    } catch {
      // fall through
    }
  }
  try {
    const params = new URLSearchParams(bodyStr)
    return params.get('refresh_token') === PLACEHOLDER_REFRESH_TOKEN
  } catch {
    return false
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const SAMPLE_BUNDLE: CodexOAuthBundle = {
  accessToken: 'access-real',
  refreshToken: 'refresh-real',
  idTokenRawJwt: makeJwt({ sub: 'user' }),
  expiresAt: 1_900_000_000_000,
  lastRefresh: '2026-04-10T00:00:00.000Z',
  accountId: 'acct-1',
}

describe('proxy readCodexCreds', () => {
  let dir: string
  let credsFile: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yaac-proxy-codex-'))
    credsFile = path.join(dir, 'codex.json')
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('returns null when the file does not exist', () => {
    expect(readCodexCreds(credsFile)).toBeNull()
  })

  it('parses an oauth entry', () => {
    fs.writeFileSync(credsFile, JSON.stringify({
      kind: 'oauth',
      savedAt: '2026-04-10T00:00:00.000Z',
      codexOauth: SAMPLE_BUNDLE,
    }))
    const creds = readCodexCreds(credsFile)
    expect(creds?.kind).toBe('oauth')
    if (creds?.kind !== 'oauth') throw new Error('expected oauth')
    expect(creds.bundle).toEqual(SAMPLE_BUNDLE)
  })

  it('parses an api-key entry', () => {
    fs.writeFileSync(credsFile, JSON.stringify({
      kind: 'api-key',
      savedAt: '2026-04-10T00:00:00.000Z',
      apiKey: 'sk-proj-xyz',
    }))
    const creds = readCodexCreds(credsFile)
    expect(creds).toEqual({ kind: 'api-key', apiKey: 'sk-proj-xyz' })
  })

  it('returns null when oauth bundle is missing required fields', () => {
    fs.writeFileSync(credsFile, JSON.stringify({
      kind: 'oauth',
      savedAt: '2026-04-10T00:00:00.000Z',
      codexOauth: { accessToken: 'x' },
    }))
    expect(readCodexCreds(credsFile)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(credsFile, 'not-json')
    expect(readCodexCreds(credsFile)).toBeNull()
  })

  it('returns null when empty apiKey in api-key entry', () => {
    fs.writeFileSync(credsFile, JSON.stringify({
      kind: 'api-key',
      savedAt: '2026-04-10T00:00:00.000Z',
      apiKey: '',
    }))
    expect(readCodexCreds(credsFile)).toBeNull()
  })
})

describe('proxy writeCodexOAuthBundle', () => {
  let dir: string
  let credsFile: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yaac-proxy-codex-write-'))
    credsFile = path.join(dir, 'codex.json')
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('writes the bundle atomically — no tmp files linger', () => {
    writeCodexOAuthBundle(credsFile, SAMPLE_BUNDLE)
    const entries = fs.readdirSync(dir)
    expect(entries).toEqual(['codex.json'])
  })

  it('round-trips via readCodexCreds', () => {
    writeCodexOAuthBundle(credsFile, SAMPLE_BUNDLE)
    const creds = readCodexCreds(credsFile)
    expect(creds?.kind).toBe('oauth')
    if (creds?.kind !== 'oauth') throw new Error('expected oauth')
    expect(creds.bundle).toEqual(SAMPLE_BUNDLE)
  })

  it('writes with 0600 permissions', () => {
    writeCodexOAuthBundle(credsFile, SAMPLE_BUNDLE)
    const stats = fs.statSync(credsFile)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing bundle', () => {
    writeCodexOAuthBundle(credsFile, SAMPLE_BUNDLE)
    const updated: CodexOAuthBundle = { ...SAMPLE_BUNDLE, accessToken: 'access-refreshed' }
    writeCodexOAuthBundle(credsFile, updated)
    const creds = readCodexCreds(credsFile)
    expect(creds?.kind).toBe('oauth')
    if (creds?.kind !== 'oauth') throw new Error('expected oauth')
    expect(creds.bundle.accessToken).toBe('access-refreshed')
  })
})

describe('proxy decodeJwtExp', () => {
  it('reads exp claim', () => {
    const jwt = makeJwt({ exp: 1234567890 })
    expect(decodeJwtExp(jwt)).toBe(1234567890 * 1000)
  })

  it('returns null when exp missing', () => {
    expect(decodeJwtExp(makeJwt({}))).toBeNull()
  })

  it('returns null for malformed JWT', () => {
    expect(decodeJwtExp('nope')).toBeNull()
  })
})

describe('proxy bodyHasPlaceholderRefreshToken', () => {
  it('detects the placeholder in a JSON body', () => {
    const body = Buffer.from(JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: PLACEHOLDER_REFRESH_TOKEN,
      client_id: 'app_xyz',
    }))
    expect(bodyHasPlaceholderRefreshToken(body, 'application/json')).toBe(true)
  })

  it('returns false for a real refresh token in a JSON body', () => {
    const body = Buffer.from(JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: 'real-refresh-abc',
    }))
    expect(bodyHasPlaceholderRefreshToken(body, 'application/json')).toBe(false)
  })

  it('detects the placeholder in a form-encoded body', () => {
    const body = Buffer.from(
      `grant_type=refresh_token&refresh_token=${PLACEHOLDER_REFRESH_TOKEN}&client_id=app_xyz`,
    )
    expect(bodyHasPlaceholderRefreshToken(body, 'application/x-www-form-urlencoded')).toBe(true)
  })

  it('returns false when no refresh_token field is present', () => {
    const body = Buffer.from(JSON.stringify({
      grant_type: 'authorization_code',
      code: 'abc',
    }))
    expect(bodyHasPlaceholderRefreshToken(body, 'application/json')).toBe(false)
  })

  it('returns false for an empty body', () => {
    expect(bodyHasPlaceholderRefreshToken(Buffer.alloc(0), 'application/json')).toBe(false)
  })

  it('returns false for a body with an authorization_code grant', () => {
    const body = Buffer.from(
      'grant_type=authorization_code&code=abc&client_id=app_xyz',
    )
    expect(bodyHasPlaceholderRefreshToken(body, 'application/x-www-form-urlencoded')).toBe(false)
  })

  it('handles application/json with charset parameter', () => {
    const body = Buffer.from(JSON.stringify({ refresh_token: PLACEHOLDER_REFRESH_TOKEN }))
    expect(bodyHasPlaceholderRefreshToken(body, 'application/json; charset=utf-8')).toBe(true)
  })

  it('falls back to form-encoded parsing when JSON parse fails', () => {
    // Content-Type says JSON but the body is form-encoded — parser should
    // fall through and still find the placeholder.
    const body = Buffer.from(`refresh_token=${PLACEHOLDER_REFRESH_TOKEN}`)
    expect(bodyHasPlaceholderRefreshToken(body, 'application/json')).toBe(true)
  })
})

describe('codex refresh-response fresh bundle shape', () => {
  // This mirrors the construction inside handleCodexTokenResponse. If upstream
  // returns new tokens, we build a fresh bundle that keeps account_id (refresh
  // responses don't echo it), updates id_token from the upstream body, and
  // derives expiresAt from the new access_token's JWT `exp`.
  function buildFresh(
    existing: CodexOAuthBundle,
    upstream: { access_token: string; refresh_token?: string; id_token?: string },
  ): CodexOAuthBundle {
    const newIdToken = typeof upstream.id_token === 'string' && upstream.id_token
      ? upstream.id_token
      : existing.idTokenRawJwt
    const exp = decodeJwtExp(upstream.access_token)
    return {
      accessToken: upstream.access_token,
      refreshToken: typeof upstream.refresh_token === 'string' && upstream.refresh_token
        ? upstream.refresh_token
        : existing.refreshToken,
      idTokenRawJwt: newIdToken,
      expiresAt: exp ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
      lastRefresh: new Date().toISOString(),
      accountId: existing.accountId,
    }
  }

  it('derives expiresAt from the new access_token JWT exp', () => {
    const newAccess = makeJwt({ exp: 1_800_000_000 })
    const newId = makeJwt({ sub: 'user', email: 'x' })
    const fresh = buildFresh(SAMPLE_BUNDLE, {
      access_token: newAccess,
      refresh_token: 'refresh-new',
      id_token: newId,
    })
    expect(fresh.expiresAt).toBe(1_800_000_000 * 1000)
    expect(fresh.idTokenRawJwt).toBe(newId)
    expect(fresh.accessToken).toBe(newAccess)
    expect(fresh.refreshToken).toBe('refresh-new')
    expect(fresh.accountId).toBe(SAMPLE_BUNDLE.accountId)
  })

  it('keeps existing refresh_token when upstream omits one', () => {
    const fresh = buildFresh(SAMPLE_BUNDLE, {
      access_token: makeJwt({ exp: 1_800_000_000 }),
    })
    expect(fresh.refreshToken).toBe(SAMPLE_BUNDLE.refreshToken)
  })

  it('keeps existing id_token when upstream omits one', () => {
    const fresh = buildFresh(SAMPLE_BUNDLE, {
      access_token: makeJwt({ exp: 1_800_000_000 }),
    })
    expect(fresh.idTokenRawJwt).toBe(SAMPLE_BUNDLE.idTokenRawJwt)
  })

  it('falls back to now+28d when new access_token has no exp', () => {
    const before = Date.now()
    const fresh = buildFresh(SAMPLE_BUNDLE, {
      access_token: makeJwt({ sub: 'x' }), // no exp
    })
    const after = Date.now()
    expect(fresh.expiresAt).toBeGreaterThanOrEqual(before + CODEX_DEFAULT_REFRESH_WINDOW_MS)
    expect(fresh.expiresAt).toBeLessThanOrEqual(after + CODEX_DEFAULT_REFRESH_WINDOW_MS)
  })
})
