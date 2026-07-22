import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_TOKEN_URL,
  refreshCodexOAuthBundle,
} from '#features/auth/codex-oauth'
import type { CodexOAuthBundle } from '@yaac/shared/types'

/** Build an access-token JWT carrying the given `exp` claim (seconds). */
function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `h.${payload}.s`
}

const BUNDLE: CodexOAuthBundle = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  idTokenRawJwt: 'old-id',
  expiresAt: 1000,
  lastRefresh: '2026-07-01T00:00:00.000Z',
  accountId: 'acc-abc',
}

describe('refreshCodexOAuthBundle', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts a refresh_token grant with the codex client id', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: jwtWithExp(exp),
      refresh_token: 'new-refresh',
      id_token: 'new-id',
    }), { status: 200 }))

    const fresh = await refreshCodexOAuthBundle(BUNDLE)
    expect(fresh).toMatchObject({
      accessToken: jwtWithExp(exp),
      refreshToken: 'new-refresh',
      idTokenRawJwt: 'new-id',
      expiresAt: exp * 1000,
      accountId: 'acc-abc',
    })
    expect(typeof fresh?.lastRefresh).toBe('string')

    expect(fetchMock.mock.calls[0][0]).toBe(CODEX_TOKEN_URL)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: CODEX_OAUTH_CLIENT_ID,
    })
  })

  it('keeps the old refresh token and id token when the response omits them', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 60),
    }), { status: 200 }))

    const fresh = await refreshCodexOAuthBundle(BUNDLE)
    expect(fresh?.refreshToken).toBe('old-refresh')
    expect(fresh?.idTokenRawJwt).toBe('old-id')
  })

  it('falls back to the default window when the new token has no decodable exp', async () => {
    const before = Date.now()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'not-a-jwt',
    }), { status: 200 }))

    const fresh = await refreshCodexOAuthBundle(BUNDLE)
    // 28-day fallback window.
    expect(fresh?.expiresAt).toBeGreaterThan(before + 27 * 24 * 60 * 60 * 1000)
  })

  it('returns null without a refresh token, without hitting the network', async () => {
    expect(await refreshCodexOAuthBundle({ ...BUNDLE, refreshToken: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on HTTP failure, a bodyless success, and network errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }))
    expect(await refreshCodexOAuthBundle(BUNDLE)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: 'x' }), { status: 200 }))
    expect(await refreshCodexOAuthBundle(BUNDLE)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'))
    expect(await refreshCodexOAuthBundle(BUNDLE)).toBeNull()
  })
})
