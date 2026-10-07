import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { buildApp } from '#main/server'
import { BUILT_IN_USER_ID, closeDb } from '#db'
import { asTailnet } from '@yaac/test-utils/api'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// Drives buildApp's full middleware chain against `/api/whoami` to test how
// the guards combine.
describe('auth middleware chain (buildApp)', () => {
  // `/whoami` lists the install's users.
  let tmpDir: string
  beforeAll(async () => { tmpDir = await createTempDataDir() })
  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })
  afterEach(() => vi.unstubAllEnvs())

  const app = () => buildApp({ buildId: 'b' })

  describe('at loopback', () => {
    it('identifies the caller as the built-in user, the only user', async () => {
      const res = await app().request('/api/whoami')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        kind: 'local', userId: BUILT_IN_USER_ID, users: [{ id: BUILT_IN_USER_ID, login: null, name: 'local' }],
      })
    })

    it('still rejects a cross-site Origin', async () => {
      const res = await app().request('/api/whoami', { headers: { origin: 'https://evil.com' } })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_ORIGIN')
    })

    it('still rejects a cross-site Sec-Fetch-Site (Origin absent)', async () => {
      const res = await app().request('/api/whoami', { headers: { 'sec-fetch-site': 'cross-site' } })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_FETCH_SITE')
    })

    it('still rejects a non-loopback Host (DNS rebinding)', async () => {
      const res = await app().request('http://evil.com/api/whoami', { headers: { host: 'evil.com' } })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_HOST')
    })
  })

  describe('at a tailnet name (YAAC_ALLOWED_HOSTS), in tailnet mode', () => {
    const HOST = 'srv.tailnet.ts.net'
    const tailnetApp = () => buildApp({ buildId: 'b', access: () => 'tailnet' })

    it('identifies the user tailscale serve stamped, and lists only tailnet users', async () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
      const res = await tailnetApp().request('/api/whoami', { headers: asTailnet('alice@example.com', HOST) })
      const body = await res.json() as { userId: string; users: unknown[] }
      expect(body).toMatchObject({ kind: 'tailnet', login: 'alice@example.com' })
      expect(body.users).toEqual([{ id: body.userId, login: 'alice@example.com', name: 'alice' }])
    })

    it('refuses the name reached without serve, and serve with no user', async () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
      expect((await tailnetApp().request('/api/whoami', { headers: { host: HOST } })).status).toBe(401)
      expect((await tailnetApp().request('/api/whoami', { headers: asTailnet(null, HOST) })).status).toBe(401)
    })

    it('never gets as far as identity when the name is not allowed', async () => {
      const res = await tailnetApp().request('/api/whoami', { headers: asTailnet('alice@example.com', HOST) })
      expect(res.status).toBe(403)
    })
  })
})
