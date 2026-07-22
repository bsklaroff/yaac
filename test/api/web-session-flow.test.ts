import http from 'node:http'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { bootInProcessServer, type InProcessServer } from '@yaac/test-utils/server'

/**
 * Full browser-auth exchange over a real socket: one-time token → cookie
 * → authorized request, plus replay and garbage rejection. The
 * store-level rules are unit-tested in token-store.test.ts; this covers
 * the wire (Set-Cookie attributes, cookie-authenticated follow-up, the
 * probe, and revocation via /tokens).
 */
describe('browser auth web-session exchange (full HTTP exchange)', () => {
  let tmpDir: string
  let server: InProcessServer

  beforeEach(async () => {
    // This suite asserts the credential gate (exchange, bare-probe 401); a
    // loopback server is credential-optional by default, so force it on.
    // buildApp reads env live, so stubbing before boot is enough.
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    tmpDir = await createTempDataDir()
    server = await bootInProcessServer()
  })

  afterEach(async () => {
    await server.stop()
    await cleanupTempDir(tmpDir)
    vi.unstubAllEnvs()
  })

  /** Mint a one-time exchange token the way `yaac open` does. */
  async function mintOneTime(): Promise<string> {
    const res = await fetch(`${server.baseUrl}/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'one-time' }),
    })
    expect(res.status).toBe(201)
    const { token } = await res.json() as { token: string }
    expect(token).toHaveLength(64)
    return token
  }

  function exchange(token: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${server.baseUrl}/auth/web-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ token }),
    })
  }

  it('exchanges a one-time token for an HttpOnly cookie that authorizes API calls', async () => {
    const res = await exchange(await mintOneTime())
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/yaac_session_[0-9a-f]{8}=[0-9a-f]{64}/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    // The cookie alone (no bearer) authorizes a protected route, and the
    // SPA's auth probe answers 204.
    const cookie = setCookie.split(';')[0]
    const list = await fetch(`${server.baseUrl}/project/list`, { headers: { cookie } })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])
    const probe = await fetch(`${server.baseUrl}/auth/web-session`, { headers: { cookie } })
    expect(probe.status).toBe(204)
  })

  it('keeps the GET probe authenticated (no cookie → 401)', async () => {
    const bare = await fetch(`${server.baseUrl}/auth/web-session`)
    expect(bare.status).toBe(401)
  })

  it('rejects a replayed one-time token (single-use) and a garbage token', async () => {
    const token = await mintOneTime()
    expect((await exchange(token)).status).toBe(204)
    expect((await exchange(token)).status).toBe(401)
    expect((await exchange('f'.repeat(64))).status).toBe(401)
  })

  it('exchanges a durable token without consuming it', async () => {
    const create = await fetch(`${server.baseUrl}/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'laptop' }),
    })
    expect(create.status).toBe(201)
    const { token } = await create.json() as { token: string }

    expect((await exchange(token)).status).toBe(204)
    expect((await exchange(token)).status).toBe(204)
    // Still a valid bearer after both exchanges.
    const viaToken = await fetch(`${server.baseUrl}/project/list`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(viaToken.status).toBe(200)
  })

  it('lists the web session as a revocable token; revoking kills the cookie', async () => {
    const res = await exchange(await mintOneTime())
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]

    const list = await fetch(`${server.baseUrl}/tokens`, {
      headers: { authorization: `Bearer ${server.secret}` },
    })
    const { tokens } = await list.json() as { tokens: Array<{ name: string; kind: string }> }
    const web = tokens.filter((t) => t.kind === 'web')
    expect(web).toHaveLength(1)
    expect(web[0].name).toMatch(/^web-[0-9a-f]{8}$/)

    const del = await fetch(`${server.baseUrl}/tokens/${web[0].name}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${server.secret}` },
    })
    expect(del.status).toBe(204)
    const after = await fetch(`${server.baseUrl}/project/list`, { headers: { cookie } })
    expect(after.status).toBe(401)
  })

  it('marks the cookie Secure only behind a trusted https proxy', async () => {
    const exchangeCookie = async (headers: Record<string, string>): Promise<string> => {
      const res = await exchange(await mintOneTime(), headers)
      expect(res.status).toBe(204)
      return res.headers.get('set-cookie') ?? ''
    }

    // Plain loopback: no Secure (browsers drop Secure cookies over http).
    expect(await exchangeCookie({})).not.toContain('Secure')

    // A spoofed X-Forwarded-Proto without the trust flag changes nothing.
    expect(await exchangeCookie({ 'x-forwarded-proto': 'https' })).not.toContain('Secure')

    // Behind tailscale serve (trust flag + forwarded proto): Secure.
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    try {
      expect(await exchangeCookie({ 'x-forwarded-proto': 'https' })).toContain('Secure')
      expect(await exchangeCookie({})).not.toContain('Secure')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('admits an extra Host only via YAAC_ALLOWED_HOSTS', async () => {
    // fetch() silently drops a Host override (forbidden header), so
    // spoof it with a raw http request — like a proxy or rebind would.
    const requestWithHost = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const url = new URL(`${server.baseUrl}/health`)
        const req = http.request(
          { hostname: url.hostname, port: url.port, path: url.pathname, headers: { host } },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })

    expect(await requestWithHost('srv.tailnet.ts.net')).toBe(403)

    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      expect(await requestWithHost('srv.tailnet.ts.net')).toBe(200)
      expect(await requestWithHost('other.ts.net')).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
