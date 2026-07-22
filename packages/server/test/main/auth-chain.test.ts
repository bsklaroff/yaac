import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildApp } from '#main/server'
import { createTokenStore } from '#http/token-store'

// Drives the full middleware chain wired in buildApp (hostHeaderCheck →
// denyBrowserCors → originHeaderCheck → fetchSiteCheck → cookieOrBearerAuth)
// against a real gated route, exercising how the guards compose. Unit-level:
// buildApp needs no cluster. The suite defaults to YAAC_REQUIRE_AUTH=1
// (vitest-setup); bypass cases clear it.
describe('auth middleware chain (buildApp)', () => {
  afterEach(() => vi.unstubAllEnvs())

  const app = () => buildApp({ secret: 'shh', buildId: 'b', tokens: createTokenStore() })
  // The GET web-session probe: gated (only POST is public), and its handler
  // just returns 204 — so it exercises the chain without needing a DB/cluster.
  const GATED = '/auth/web-session'

  describe('loopback-only (no credential required)', () => {
    it('serves a gated route with no credential', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '')
      const res = await app().request(GATED)
      expect(res.status).toBe(204)
    })

    it('still rejects a cross-site Origin', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '')
      const res = await app().request(GATED, { headers: { origin: 'https://evil.com' } })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_ORIGIN')
    })

    it('still rejects a cross-site Sec-Fetch-Site (Origin absent)', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '')
      const res = await app().request(GATED, { headers: { 'sec-fetch-site': 'cross-site' } })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_FETCH_SITE')
    })

    it('still rejects a non-loopback Host (DNS rebinding)', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '')
      const res = await app().request('http://evil.com/auth/web-session', {
        headers: { host: 'evil.com' },
      })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_HOST')
    })
  })

  describe('credential forced on (YAAC_REQUIRE_AUTH=1)', () => {
    it('rejects a gated route with no credential', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
      const res = await app().request(GATED)
      expect(res.status).toBe(401)
    })

    it('accepts the correct bearer', async () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
      const res = await app().request(GATED, { headers: { authorization: 'Bearer shh' } })
      expect(res.status).toBe(204)
    })
  })
})
