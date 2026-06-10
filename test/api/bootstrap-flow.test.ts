import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'

/**
 * Full browser-auth bootstrap exchange over a real socket, per the test
 * strategy in draft-plans/webapp-daemon-follow-up.md: code → cookie →
 * authorized request, plus replay and garbage rejection. The store-level
 * rules are unit-tested in web-auth.test.ts; this covers the wire
 * (Set-Cookie attributes, cookie-authenticated follow-up).
 */
describe('browser auth bootstrap (full HTTP exchange)', () => {
  let tmpDir: string
  let daemon: InProcessDaemon

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    daemon = await bootInProcessDaemon()
  })

  afterEach(async () => {
    await daemon.stop()
    await cleanupTempDir(tmpDir)
  })

  it('exchanges the code for an HttpOnly cookie that authorizes API calls', async () => {
    const codeRes = await fetch(`${daemon.baseUrl}/auth/bootstrap-code`, {
      headers: { authorization: `Bearer ${daemon.secret}` },
    })
    expect(codeRes.status).toBe(200)
    const { code } = await codeRes.json() as { code: string }
    expect(code).toHaveLength(64)

    const exchange = await fetch(`${daemon.baseUrl}/auth/bootstrap`, {
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
    const list = await fetch(`${daemon.baseUrl}/project/list`, {
      headers: { cookie },
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])
  })

  it('rejects a replayed code (single-use) and a garbage code', async () => {
    const { code } = await (await fetch(`${daemon.baseUrl}/auth/bootstrap-code`, {
      headers: { authorization: `Bearer ${daemon.secret}` },
    })).json() as { code: string }

    const first = await fetch(`${daemon.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(first.status).toBe(204)

    const replay = await fetch(`${daemon.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(replay.status).toBe(401)

    const garbage = await fetch(`${daemon.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'f'.repeat(64) }),
    })
    expect(garbage.status).toBe(401)
  })

  it('a consumed exchange rotates the code for the next client', async () => {
    const readCode = async (): Promise<string> => {
      const res = await fetch(`${daemon.baseUrl}/auth/bootstrap-code`, {
        headers: { authorization: `Bearer ${daemon.secret}` },
      })
      return ((await res.json()) as { code: string }).code
    }
    const before = await readCode()
    await fetch(`${daemon.baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: before }),
    })
    const after = await readCode()
    expect(after).not.toBe(before)
    expect(after).toHaveLength(64)
  })
})
