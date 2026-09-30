import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildApp } from '#main/server'
import { asTailnet } from '@yaac/test-utils/api'

// Drives buildApp's full middleware chain against `/api/whoami` to test how
// the guards combine.
describe('auth middleware chain (buildApp)', () => {
  afterEach(() => vi.unstubAllEnvs())

  const app = () => buildApp({ buildId: 'b' })

  describe('at loopback', () => {
    it('identifies the caller as local', async () => {
      const res = await app().request('/api/whoami')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ kind: 'local' })
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

  describe('at a tailnet name (YAAC_ALLOWED_HOSTS)', () => {
    const HOST = 'srv.tailnet.ts.net'

    it('identifies the user tailscale serve stamped', async () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
      const res = await app().request('/api/whoami', { headers: asTailnet('alice@example.com', HOST) })
      expect(await res.json()).toMatchObject({ kind: 'tailnet', login: 'alice@example.com' })
    })

    it('refuses the name reached without serve, and serve with no user', async () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
      expect((await app().request('/api/whoami', { headers: { host: HOST } })).status).toBe(401)
      expect((await app().request('/api/whoami', { headers: asTailnet(null, HOST) })).status).toBe(401)
    })

    it('never gets as far as identity when the name is not allowed', async () => {
      const res = await app().request('/api/whoami', { headers: asTailnet('alice@example.com', HOST) })
      expect(res.status).toBe(403)
    })
  })
})
