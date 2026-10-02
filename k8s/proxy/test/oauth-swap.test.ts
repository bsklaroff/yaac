import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import type { CodexOAuthBundle, RefreshedBundles } from 'yaac-proxy-sidecar/objects'
import { PLACEHOLDER_ACCESS_TOKEN, PLACEHOLDER_REFRESH_TOKEN } from 'yaac-proxy-sidecar/injection'
import { collectTokenReply, rotationFrom, type HeldBundle, type TokenReply } from 'yaac-proxy-sidecar/oauth-swap'

const jwt = (payload: Record<string, unknown>): string =>
  ['{"alg":"none"}', JSON.stringify(payload), ''].map((p) => Buffer.from(p).toString('base64url')).join('.')

const CODEX: CodexOAuthBundle = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  idTokenRawJwt: 'old-id',
  expiresAt: 1,
  lastRefresh: '2026-01-01T00:00:00Z',
  accountId: 'acct',
}

describe('rotationFrom', () => {
  it('builds the codex bundle from the response, keeping what it omits', () => {
    const held: HeldBundle = { tool: 'codex', bundle: CODEX }
    const access = jwt({ exp: 1_800_000_000 })
    expect(rotationFrom(held, { access_token: access, refresh_token: 'new-refresh', id_token: 'new-id' }).codex)
      .toMatchObject({ accessToken: access, refreshToken: 'new-refresh', idTokenRawJwt: 'new-id',
        expiresAt: 1_800_000_000_000, accountId: 'acct' })
    expect(rotationFrom(held, { access_token: access }).codex)
      .toMatchObject({ refreshToken: 'old-refresh', idTokenRawJwt: 'old-id' })

    // An access token with no exp lasts the default 28 days.
    const before = Date.now()
    const fresh = rotationFrom(held, { access_token: jwt({ sub: 'x' }) }).codex!
    expect(fresh.expiresAt - before).toBeGreaterThanOrEqual(28 * 24 * 60 * 60 * 1000)
  })

  it('builds the claude bundle from expires_in and scope', () => {
    const held: HeldBundle = {
      tool: 'claude',
      bundle: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: ['old'], subscriptionType: 'max' },
    }
    const before = Date.now()
    const fresh = rotationFrom(held, { access_token: 'a2', expires_in: 60, scope: 'user:inference user:profile' }).claude!
    expect(fresh).toMatchObject({ accessToken: 'a2', refreshToken: 'r', scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max' })
    expect(fresh.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
  })
})

describe('collectTokenReply', () => {
  function reply(body: Buffer, headers: http.IncomingHttpHeaders = {}): Promise<{
    reply: TokenReply
    captured: RefreshedBundles[]
  }> {
    const upstream = Object.assign(Readable.from([body]), { headers, statusCode: 200 }) as unknown as http.IncomingMessage
    const captured: RefreshedBundles[] = []
    return new Promise((resolve) => {
      collectTokenReply(upstream, { tool: 'codex', bundle: CODEX }, (b) => captured.push(b),
        (r) => { resolve({ reply: r, captured }) })
    })
  }

  it('captures the rotation and answers with placeholders, in the response\'s own encoding', async () => {
    const body = JSON.stringify({ access_token: jwt({ exp: 2 }), refresh_token: 'new-refresh', token_type: 'Bearer' })
    const { reply: r, captured } = await reply(zlib.gzipSync(body), {
      'content-encoding': 'gzip', 'transfer-encoding': 'chunked',
    })
    expect(captured[0].codex?.refreshToken).toBe('new-refresh')
    expect(r.rotatedTo).toBe('new-refresh')
    expect(r.headers['transfer-encoding']).toBeUndefined()
    expect(JSON.parse(zlib.gunzipSync(r.body).toString())).toEqual({
      access_token: PLACEHOLDER_ACCESS_TOKEN, refresh_token: PLACEHOLDER_REFRESH_TOKEN, token_type: 'Bearer',
    })
  })

  it('passes an error or an unknown encoding through untouched', async () => {
    for (const [body, headers] of [
      [Buffer.from('{"error":"invalid_grant"}'), {}],
      [Buffer.from('opaque'), { 'content-encoding': 'zstd' }],
    ] as const) {
      const { reply: r, captured } = await reply(body, headers)
      expect(captured).toEqual([])
      expect(r.rotatedTo).toBeNull()
      expect(r.body).toEqual(body)
    }
  })
})
