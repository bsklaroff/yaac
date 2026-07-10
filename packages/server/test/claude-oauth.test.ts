import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  refreshClaudeOAuthBundle,
} from '#lib/auth/claude-oauth'
import type { ClaudeOAuthBundle } from '@yaac/shared/types'

describe('refreshClaudeOAuthBundle', () => {
  const fetchMock = vi.fn<typeof fetch>()

  const bundle: ClaudeOAuthBundle = {
    accessToken: 'tok-old',
    refreshToken: 'ref-old',
    expiresAt: 1783600000000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1783700000000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('posts a refresh_token grant and returns the refreshed bundle', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'tok-new',
      refresh_token: 'ref-new',
      expires_in: 28800,
      scope: 'user:inference user:profile',
      token_type: 'Bearer',
    }), { status: 200 }))

    expect(await refreshClaudeOAuthBundle(bundle)).toEqual({
      accessToken: 'tok-new',
      refreshToken: 'ref-new',
      expiresAt: 1783700000000 + 28800 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    })

    expect(fetchMock).toHaveBeenCalledWith(CLAUDE_TOKEN_URL, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: 'ref-old',
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    }))
  })

  it('keeps stored fields the response omits', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'tok-new',
    }), { status: 200 }))

    expect(await refreshClaudeOAuthBundle(bundle)).toEqual({
      accessToken: 'tok-new',
      refreshToken: 'ref-old',
      expiresAt: 1783600000000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })
  })

  it('skips the grant entirely for a bundle without a refresh token', async () => {
    expect(await refreshClaudeOAuthBundle({ ...bundle, refreshToken: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is null on HTTP failures, unrecognized bodies, and network errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }))
    expect(await refreshClaudeOAuthBundle(bundle)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 }))
    expect(await refreshClaudeOAuthBundle(bundle)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    expect(await refreshClaudeOAuthBundle(bundle)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'))
    expect(await refreshClaudeOAuthBundle(bundle)).toBeNull()
  })
})
