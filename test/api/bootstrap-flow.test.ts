import http from 'node:http'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { bootInProcessServer, type InProcessServer } from '@test/helpers/server'

/**
 * Full browser-auth bootstrap exchange over a real socket, per the test
 * strategy in plans/webapp-server-follow-up.md: code → cookie →
 * authorized request, plus replay and garbage rejection. The store-level
 * rules are unit-tested in web-auth.test.ts; this covers the wire
 * (Set-Cookie attributes, cookie-authenticated follow-up).
 */
describe('browser auth bootstrap (full HTTP exchange)', () => {
  let tmpDir: string
  let server: InProcessServer

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    server = await bootInProcessServer()
  })

  afterEach(async () => {
    await server.stop()
    await cleanupTempDir(tmpDir)
  })

  it('exchanges the code for an HttpOnly cookie that authorizes API calls', async () => {
    const codeRes = await fetch(`${server.baseUrl}/auth/bootstrap-code`, {
      headers: { authorization: `Bearer ${server.secret}` },
    })
    expect(codeRes.status).toBe(200)
    const { code } = await codeRes.json() as { code: string }
    expect(code).toHaveLength(64)

    const exchange = await fetch(`${server.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(exchange.status).toBe(204)
    const setCookie = exchange.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/yaac_session=[0-9a-f]{64}/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    // The cookie alone (no bearer) authorizes a protected route.
    const cookie = setCookie.split(';')[0]
    const list = await fetch(`${server.baseUrl}/project/list`, {
      headers: { cookie },
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])
  })

  it('rejects a replayed code (single-use) and a garbage code', async () => {
    const { code } = await (await fetch(`${server.baseUrl}/auth/bootstrap-code`, {
      headers: { authorization: `Bearer ${server.secret}` },
    })).json() as { code: string }

    const first = await fetch(`${server.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(first.status).toBe(204)

    const replay = await fetch(`${server.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(replay.status).toBe(401)

    const garbage = await fetch(`${server.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'f'.repeat(64) }),
    })
    expect(garbage.status).toBe(401)
  })

  it('a consumed exchange rotates the code for the next client', async () => {
    const readCode = async (): Promise<string> => {
      const res = await fetch(`${server.baseUrl}/auth/bootstrap-code`, {
        headers: { authorization: `Bearer ${server.secret}` },
      })
      return ((await res.json()) as { code: string }).code
    }
    const before = await readCode()
    await fetch(`${server.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: before }),
    })
    const after = await readCode()
    expect(after).not.toBe(before)
    expect(after).toHaveLength(64)
  })

  it('marks the cookie Secure only behind a trusted https proxy', async () => {
    const exchange = async (headers: Record<string, string>): Promise<string> => {
      const { code } = await (await fetch(`${server.baseUrl}/auth/bootstrap-code`, {
        headers: { authorization: `Bearer ${server.secret}` },
      })).json() as { code: string }
      const res = await fetch(`${server.baseUrl}/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ code }),
      })
      expect(res.status).toBe(204)
      return res.headers.get('set-cookie') ?? ''
    }

    // Plain loopback: no Secure (browsers drop Secure cookies over http).
    expect(await exchange({})).not.toContain('Secure')

    // A spoofed X-Forwarded-Proto without the trust flag changes nothing.
    expect(await exchange({ 'x-forwarded-proto': 'https' })).not.toContain('Secure')

    // Behind tailscale serve (trust flag + forwarded proto): Secure.
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    try {
      expect(await exchange({ 'x-forwarded-proto': 'https' })).toContain('Secure')
      expect(await exchange({})).not.toContain('Secure')
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
