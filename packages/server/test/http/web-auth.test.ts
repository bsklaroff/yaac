import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  cookieOrBearerAuth,
  createTokenStore,
  fetchSiteCheck,
  hostHeaderCheck,
  isCredentialOptional,
  originHeaderCheck,
  sessionCookieName,
} from '#http'
// Setup value, not a unit under test: the cookie name is `<base>_<hash>`, so
// asserting the shape means naming the same base the module does.
import { SESSION_COOKIE_BASE } from '#http/web-auth'
import { getDataDir, setDataDir } from '@yaac/shared/paths'

/**
 * A gate over the paths that decide the public/gated split: the SPA shell and
 * its assets, the health probe, both methods of the token→cookie exchange,
 * and an ordinary API route.
 */
function appWithAuth(): { app: Hono; tokens: ReturnType<typeof createTokenStore> } {
  const tokens = createTokenStore()
  const app = new Hono()
  app.use('*', cookieOrBearerAuth('shh', tokens))
  app.get('/health', (c) => c.text('ok'))
  app.get('/', (c) => c.text('shell'))
  app.get('/assets/*', (c) => c.text('asset'))
  app.post('/auth/web-session', (c) => c.text('exchanged'))
  app.get('/auth/web-session', (c) => c.text('probe ok'))
  app.get('/session/list', (c) => c.text('protected ok'))
  return { app, tokens }
}

/** A fresh web-session secret, minted the way the exchange route does. */
function mintSession(tokens: ReturnType<typeof createTokenStore>): string {
  return tokens.consumeExchange(tokens.mintExchangeToken().token) as string
}

describe('cookieOrBearerAuth', () => {
  // Most of these assert the credential gate itself, so force it on (a
  // loopback test server is credential-optional by default); the bypass cases
  // clear it again.
  beforeEach(() => vi.stubEnv('YAAC_REQUIRE_AUTH', '1'))
  afterEach(() => vi.unstubAllEnvs())

  it('lets the shell, its assets, health and the POST exchange through with no credential', async () => {
    const { app } = appWithAuth()
    expect((await app.request('/health')).status).toBe(200)
    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/assets/index-abc.js')).status).toBe(200)
    expect((await app.request('/auth/web-session', { method: 'POST' })).status).toBe(200)
  })

  it('gates API paths and the GET web-session probe', async () => {
    const { app } = appWithAuth()
    for (const path of ['/session/list', '/auth/web-session']) {
      const res = await app.request(path)
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('UNAUTHENTICATED')
    }
  })

  it('accepts a correct bearer, case-insensitively', async () => {
    const { app } = appWithAuth()
    const a = await app.request('/session/list', {
      headers: { authorization: 'Bearer shh' },
    })
    expect(a.status).toBe(200)
    const b = await app.request('/session/list', {
      headers: { authorization: 'bearer shh' },
    })
    expect(b.status).toBe(200)
  })

  it('rejects a wrong bearer with BAD_BEARER (drives the CLI re-resolve retry)', async () => {
    const { app } = appWithAuth()
    // Both shapes the constant-time compare has to handle: a same-length
    // near-miss and a length mismatch (which it must reject, not throw on).
    for (const bearer of ['shX', 'a-much-longer-guess']) {
      const res = await app.request('/session/list', {
        headers: { authorization: `Bearer ${bearer}` },
      })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('BAD_BEARER')
    }
  })

  it('accepts a durable token bearer', async () => {
    const { app, tokens } = appWithAuth()
    const entry = tokens.create('laptop')

    const ok = await app.request('/session/list', {
      headers: { authorization: `Bearer ${entry.token}` },
    })
    expect(ok.status).toBe(200)
  })

  it('rejects a one-time token or a web session presented as a bearer', async () => {
    const { app, tokens } = appWithAuth()
    for (const bearer of [tokens.mintExchangeToken().token, mintSession(tokens)]) {
      const res = await app.request('/session/list', {
        headers: { authorization: `Bearer ${bearer}` },
      })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('BAD_BEARER')
    }
  })

  it('lets a valid cookie override a stale bearer', async () => {
    const { app, tokens } = appWithAuth()
    const sid = mintSession(tokens)
    const res = await app.request('/session/list', {
      headers: {
        authorization: 'Bearer stale',
        cookie: `${sessionCookieName()}=${sid}`,
      },
    })
    expect(res.status).toBe(200)
  })

  it('accepts a valid session cookie and rejects an invalid one', async () => {
    const { app, tokens } = appWithAuth()
    const sid = mintSession(tokens)
    expect(sid.length).toBeGreaterThan(0)

    const ok = await app.request('/session/list', {
      headers: { cookie: `${sessionCookieName()}=${sid}` },
    })
    expect(ok.status).toBe(200)

    const bad = await app.request('/session/list', {
      headers: { cookie: `${sessionCookieName()}=bogus` },
    })
    expect(bad.status).toBe(401)
  })

  it('rejects a durable token presented as a cookie', async () => {
    const { app, tokens } = appWithAuth()
    const entry = tokens.create('laptop')
    const res = await app.request('/session/list', {
      headers: { cookie: `${sessionCookieName()}=${entry.token}` },
    })
    expect(res.status).toBe(401)
  })

  it('skips the gate entirely on a loopback-only deployment', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    const { app } = appWithAuth()
    expect((await app.request('/session/list')).status).toBe(200)
    // Not even a wrong bearer is rejected — the gate is not consulted at all.
    const wrong = await app.request('/session/list', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(wrong.status).toBe(200)
  })

  it('re-enforces the gate once remote hosting is configured', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    expect((await appWithAuth().app.request('/session/list')).status).toBe(401)
  })

  it('bypasses a nested yaac despite inherited remote-host env', async () => {
    // yaac-in-yaac: allowedHosts/trustProxy inherited from the outer session,
    // but reachability is via the outer's (tailnet-gated) port-forward.
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    vi.stubEnv('YAAC_NESTED', '1')
    expect((await appWithAuth().app.request('/session/list')).status).toBe(200)
  })
})

describe('isCredentialOptional', () => {
  // The suite defaults to YAAC_REQUIRE_AUTH=1; clear it to see the underlying
  // posture. YAAC_NESTED is stripped by unit-setup, so it's off by default.
  afterEach(() => vi.unstubAllEnvs())

  it('is true for a pure loopback deployment', () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    expect(isCredentialOptional()).toBe(true)
  })

  it('is false once remote hosting is configured (and not nested)', () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    expect(isCredentialOptional()).toBe(false)
    // Either half of the remote-hosting posture is enough on its own.
    vi.unstubAllEnvs()
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    expect(isCredentialOptional()).toBe(false)
  })

  it('is true for a nested yaac even with inherited remote-host env', () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    vi.stubEnv('YAAC_NESTED', '1')
    expect(isCredentialOptional()).toBe(true)
  })

  it('is false whenever YAAC_REQUIRE_AUTH forces the gate on', () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    vi.stubEnv('YAAC_NESTED', '1')
    expect(isCredentialOptional()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    expect(isCredentialOptional()).toBe(false)
  })
})

describe('sessionCookieName', () => {
  const original = getDataDir()
  afterEach(() => setDataDir(original))

  it('derives yaac_session_<hash> from the data dir', () => {
    setDataDir('/home/ben/.yaac')
    expect(sessionCookieName()).toMatch(new RegExp(`^${SESSION_COOKIE_BASE}_[0-9a-f]{8}$`))
  })

  it('is stable for a given data dir', () => {
    setDataDir('/some/data/dir')
    expect(sessionCookieName()).toBe(sessionCookieName())
  })

  it('gives co-hosted servers distinct names (the shared-host collision fix)', () => {
    setDataDir('/home/ben/.yaac')
    const outer = sessionCookieName()
    setDataDir('/home/ben/.yaac/projects/yaac/sessions/abc/nested-yaac')
    expect(sessionCookieName()).not.toBe(outer)
  })
})

describe('hostHeaderCheck', () => {
  function appWithHostCheck(): Hono {
    const app = new Hono()
    app.use('*', hostHeaderCheck())
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('allows loopback hosts, with or without a port', async () => {
    for (const host of ['127.0.0.1', 'localhost:9788', 'LocalHost']) {
      const res = await appWithHostCheck().request('/x', { headers: { host } })
      expect(res.status).toBe(200)
    }
  })

  it('falls back to the URL host when no Host header is sent (in-memory dispatch)', async () => {
    const ok = await appWithHostCheck().request('/x')
    expect(ok.status).toBe(200)
    const rebind = await appWithHostCheck().request('http://evil.com/x')
    expect(rebind.status).toBe(403)
  })

  it('rejects a non-loopback host', async () => {
    const res = await appWithHostCheck().request('http://evil.com/x', {
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_HOST')
  })

  it('admits a host from YAAC_ALLOWED_HOSTS, any case or port, read per request', async () => {
    const app = appWithHostCheck()
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      const ok = await app.request('/x', { headers: { host: 'SRV.Tailnet.TS.NET:443' } })
      expect(ok.status).toBe(200)
      const other = await app.request('/x', { headers: { host: 'other.ts.net' } })
      expect(other.status).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
    // Back to the default allowlist without rebuilding the app.
    expect((await app.request('/x', { headers: { host: 'srv.tailnet.ts.net' } })).status).toBe(403)
  })
})

describe('originHeaderCheck', () => {
  function appWithOriginCheck(): Hono {
    const app = new Hono()
    app.use('*', originHeaderCheck())
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('allows an absent or empty Origin (CLI, same-origin GET)', async () => {
    expect((await appWithOriginCheck().request('/x')).status).toBe(200)
    const empty = await appWithOriginCheck().request('/x', { headers: { origin: '' } })
    expect(empty.status).toBe(200)
  })

  it('allows a loopback Origin on any port (the SPA and the Vite dev proxy)', async () => {
    const res = await appWithOriginCheck().request('/x', {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a website Origin with BAD_ORIGIN', async () => {
    const res = await appWithOriginCheck().request('/x', {
      headers: { origin: 'https://evil.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_ORIGIN')
  })

  it('fails closed on an opaque, host-less or unparseable Origin', async () => {
    // 'null' (opaque origin) and garbage don't parse; a non-http scheme parses
    // but carries no host, which is not a host the allowlist can ever admit.
    for (const origin of ['null', 'not a url', 'foo:bar']) {
      const res = await appWithOriginCheck().request('/x', { headers: { origin } })
      expect(res.status).toBe(403)
    }
  })

  it('admits an Origin from YAAC_ALLOWED_HOSTS (read per request)', async () => {
    const app = appWithOriginCheck()
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      const ok = await app.request('/x', { headers: { origin: 'https://srv.tailnet.ts.net' } })
      expect(ok.status).toBe(200)
      const other = await app.request('/x', { headers: { origin: 'https://evil.com' } })
      expect(other.status).toBe(403)
      // Loopback stays allowed regardless of the list.
      const local = await app.request('/x', { headers: { origin: 'http://localhost' } })
      expect(local.status).toBe(200)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('fetchSiteCheck', () => {
  function appWithFetchSiteCheck(): Hono {
    const app = new Hono()
    app.use('*', fetchSiteCheck())
    app.get('/x', (c) => c.text('ok'))
    app.post('/x', (c) => c.text('ok'))
    return app
  }

  it('allows an absent or empty Sec-Fetch-Site (CLI, older browser)', async () => {
    expect((await appWithFetchSiteCheck().request('/x')).status).toBe(200)
    const empty = await appWithFetchSiteCheck().request('/x', {
      headers: { 'sec-fetch-site': '' },
    })
    expect(empty.status).toBe(200)
  })

  it('allows same-origin fetches and user-initiated (none) loads', async () => {
    const spa = await appWithFetchSiteCheck().request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(spa.status).toBe(200)
    const typed = await appWithFetchSiteCheck().request('/x', {
      headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    expect(typed.status).toBe(200)
  })

  it('rejects cross-site and same-site sub-resource loads with BAD_FETCH_SITE', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_FETCH_SITE')

    const sameSite = await appWithFetchSiteCheck().request('/x', {
      headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    })
    expect(sameSite.status).toBe(403)
  })

  it('allows a cross-site top-level document navigation (linkable webapp)', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a cross-site navigation that is not a top-level document GET', async () => {
    // Embedded (iframe/embed) navigation — a site trying to frame the app —
    // plus a non-GET and a dest-less navigation.
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    ]
    for (const headers of cases) {
      expect((await appWithFetchSiteCheck().request('/x', { headers })).status).toBe(403)
    }
    const post = await appWithFetchSiteCheck().request('/x', {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(post.status).toBe(403)
  })
})
