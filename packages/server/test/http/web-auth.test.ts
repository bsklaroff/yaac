import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  timingSafeStrEqual,
  cookieOrBearerAuth,
  hostHeaderCheck,
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
  isCredentialOptional,
  isLoopbackOnlyDeployment,
  isPublicPath,
  fetchSiteCheck,
  originHeaderCheck,
  SESSION_COOKIE_BASE,
  sessionCookieName,
} from '#http/web-auth'
import { createTokenStore } from '#http/token-store'
import { getDataDir, setDataDir } from '@yaac/shared/paths'

describe('isPublicPath', () => {
  it('allows the SPA shell, assets, health, and the POST exchange', () => {
    expect(isPublicPath('GET', '/')).toBe(true)
    expect(isPublicPath('GET', '/assets/index-abc.js')).toBe(true)
    expect(isPublicPath('GET', '/health')).toBe(true)
    expect(isPublicPath('POST', '/auth/web-session')).toBe(true)
  })

  it('keeps the GET web-session probe authenticated', () => {
    expect(isPublicPath('GET', '/auth/web-session')).toBe(false)
  })

  it('does not allow API paths', () => {
    expect(isPublicPath('GET', '/session/list')).toBe(false)
    expect(isPublicPath('GET', '/auth/list')).toBe(false)
    expect(isPublicPath('GET', '/events')).toBe(false)
  })
})

describe('isAllowedHost', () => {
  it('allows loopback hostnames with a port', () => {
    expect(isAllowedHost('127.0.0.1:5000')).toBe(true)
    expect(isAllowedHost('localhost:5000')).toBe(true)
  })

  it('allows a loopback hostname without a port', () => {
    expect(isAllowedHost('localhost')).toBe(true)
    expect(isAllowedHost('127.0.0.1')).toBe(true)
  })

  it('rejects non-loopback hostnames (DNS rebinding)', () => {
    expect(isAllowedHost('evil.com:5000')).toBe(false)
    expect(isAllowedHost('evil.com')).toBe(false)
    expect(isAllowedHost('')).toBe(false)
  })

  it('allows any port on a loopback host (port-forward remaps it)', () => {
    expect(isAllowedHost('127.0.0.1:9999')).toBe(true)
    expect(isAllowedHost('localhost:9788')).toBe(true)
  })

  it('admits extra allowed hostnames case-insensitively, any port', () => {
    const allowed = ['srv.tailnet.ts.net']
    expect(isAllowedHost('srv.tailnet.ts.net', allowed)).toBe(true)
    expect(isAllowedHost('SRV.Tailnet.TS.NET:443', allowed)).toBe(true)
    expect(isAllowedHost('other.ts.net', allowed)).toBe(false)
  })

  it('keeps loopback allowed regardless of the extra list', () => {
    expect(isAllowedHost('127.0.0.1', ['srv.ts.net'])).toBe(true)
    expect(isAllowedHost('localhost:9788', [])).toBe(true)
  })
})

describe('isAllowedOrigin', () => {
  it('allows an absent or empty Origin (non-browser clients, same-origin GETs)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
    expect(isAllowedOrigin('')).toBe(true)
  })

  it('allows a loopback Origin on any port', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:8787')).toBe(true)
  })

  it('rejects a website Origin', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    expect(isAllowedOrigin('https://evil.com:8787')).toBe(false)
  })

  it('fails closed on an opaque or unparseable Origin', () => {
    expect(isAllowedOrigin('null')).toBe(false)
    expect(isAllowedOrigin('not a url')).toBe(false)
  })

  it('admits an allow-listed host, loopback regardless of the list', () => {
    const allowed = ['srv.tailnet.ts.net']
    expect(isAllowedOrigin('https://srv.tailnet.ts.net', allowed)).toBe(true)
    expect(isAllowedOrigin('https://other.ts.net', allowed)).toBe(false)
    expect(isAllowedOrigin('http://localhost', allowed)).toBe(true)
  })
})

describe('isLoopbackOnlyDeployment', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is true with no remote-host env (the default local posture)', () => {
    expect(isLoopbackOnlyDeployment()).toBe(true)
  })

  it('is false once YAAC_ALLOWED_HOSTS or YAAC_TRUST_PROXY is set', () => {
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    expect(isLoopbackOnlyDeployment()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    expect(isLoopbackOnlyDeployment()).toBe(false)
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

describe('isAllowedFetchSite', () => {
  it('allows an absent header (non-browser / older browsers)', () => {
    expect(isAllowedFetchSite(undefined, undefined, undefined, 'POST')).toBe(true)
    expect(isAllowedFetchSite('', undefined, undefined, 'POST')).toBe(true)
  })

  it('allows same-origin and user-initiated (none) requests', () => {
    expect(isAllowedFetchSite('same-origin', 'cors', 'empty', 'POST')).toBe(true)
    expect(isAllowedFetchSite('none', 'navigate', 'document', 'GET')).toBe(true)
  })

  it('rejects cross-site and same-site sub-resource loads', () => {
    expect(isAllowedFetchSite('cross-site', 'cors', 'empty', 'POST')).toBe(false)
    expect(isAllowedFetchSite('cross-site', 'websocket', 'empty', 'GET')).toBe(false)
    expect(isAllowedFetchSite('same-site', 'cors', 'empty', 'GET')).toBe(false)
  })

  it('allows a cross-site top-level document navigation (linkable webapp)', () => {
    expect(isAllowedFetchSite('cross-site', 'navigate', 'document', 'GET')).toBe(true)
  })

  it('rejects a cross-site navigation that is not a top-level document', () => {
    // Embedded (iframe/embed) navigation — a site trying to frame the app.
    expect(isAllowedFetchSite('cross-site', 'navigate', 'iframe', 'GET')).toBe(false)
    // Non-GET or missing dest.
    expect(isAllowedFetchSite('cross-site', 'navigate', 'document', 'POST')).toBe(false)
    expect(isAllowedFetchSite('cross-site', 'navigate', undefined, 'GET')).toBe(false)
  })
})

function appWithAuth(): { app: Hono; tokens: ReturnType<typeof createTokenStore> } {
  const tokens = createTokenStore()
  const app = new Hono()
  app.use('*', cookieOrBearerAuth('shh', tokens))
  app.get('/health', (c) => c.text('ok'))
  app.get('/session/list', (c) => c.text('protected ok'))
  return { app, tokens }
}

/** A fresh web-session secret, minted the way the exchange route does. */
function mintSession(tokens: ReturnType<typeof createTokenStore>): string {
  return tokens.consumeExchange(tokens.mintExchangeToken().token) as string
}

describe('cookieOrBearerAuth', () => {
  // These assert the credential gate itself, so force it on (a loopback test
  // server is credential-optional by default).
  beforeEach(() => vi.stubEnv('YAAC_REQUIRE_AUTH', '1'))
  afterEach(() => vi.unstubAllEnvs())

  it('allows public paths with no credentials', async () => {
    const res = await appWithAuth().app.request('/health')
    expect(res.status).toBe(200)
  })

  it('rejects a protected path with no credentials', async () => {
    const res = await appWithAuth().app.request('/session/list')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
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
    const res = await appWithAuth().app.request('/session/list', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
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
})

describe('cookieOrBearerAuth — loopback-only bypass', () => {
  // The suite defaults to YAAC_REQUIRE_AUTH=1 (vitest-setup); clear it to
  // exercise the default local posture where the gate is skipped.
  afterEach(() => vi.unstubAllEnvs())

  it('passes a protected path with no credential when loopback-only', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    const res = await appWithAuth().app.request('/session/list')
    expect(res.status).toBe(200)
  })

  it('does not even reject a wrong bearer when bypassed', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    const res = await appWithAuth().app.request('/session/list', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(200)
  })

  it('re-enforces the gate when YAAC_REQUIRE_AUTH=1', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    const res = await appWithAuth().app.request('/session/list')
    expect(res.status).toBe(401)
  })

  it('re-enforces the gate once remote hosting is configured', async () => {
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    const res = await appWithAuth().app.request('/session/list')
    expect(res.status).toBe(401)
  })

  it('bypasses a nested yaac despite inherited remote-host env', async () => {
    // yaac-in-yaac: allowedHosts/trustProxy inherited from the outer session,
    // but reachability is via the outer's (tailnet-gated) port-forward.
    vi.stubEnv('YAAC_REQUIRE_AUTH', '')
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    vi.stubEnv('YAAC_NESTED', '1')
    const res = await appWithAuth().app.request('/session/list')
    expect(res.status).toBe(200)
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

describe('timingSafeStrEqual', () => {
  it('matches equal strings and rejects unequal ones', () => {
    expect(timingSafeStrEqual('secret', 'secret')).toBe(true)
    expect(timingSafeStrEqual('secret', 'secreT')).toBe(false)
  })

  it('rejects length mismatches without throwing', () => {
    expect(timingSafeStrEqual('short', 'longer-value')).toBe(false)
    expect(timingSafeStrEqual('', 'x')).toBe(false)
    expect(timingSafeStrEqual('', '')).toBe(true)
  })
})

describe('hostHeaderCheck', () => {
  function appWithHostCheck(): Hono {
    const app = new Hono()
    app.use('*', hostHeaderCheck())
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('allows loopback hosts', async () => {
    const res = await appWithHostCheck().request('/x', { headers: { host: '127.0.0.1' } })
    expect(res.status).toBe(200)
  })

  it('allows a loopback host on a forwarded (non-bound) port', async () => {
    const res = await appWithHostCheck().request('/x', { headers: { host: 'localhost:9788' } })
    expect(res.status).toBe(200)
  })

  it('rejects a non-loopback host', async () => {
    const res = await appWithHostCheck().request('http://evil.com/x', {
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_HOST')
  })

  it('admits a host from YAAC_ALLOWED_HOSTS (read per request)', async () => {
    const app = appWithHostCheck()
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      const ok = await app.request('/x', { headers: { host: 'srv.tailnet.ts.net' } })
      expect(ok.status).toBe(200)
      const other = await app.request('/x', { headers: { host: 'evil.com' } })
      expect(other.status).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('originHeaderCheck', () => {
  function appWithOriginCheck(): Hono {
    const app = new Hono()
    app.use('*', originHeaderCheck())
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('allows a request with no Origin (CLI, same-origin GET)', async () => {
    const res = await appWithOriginCheck().request('/x')
    expect(res.status).toBe(200)
  })

  it('allows a loopback Origin (the SPA and the Vite dev proxy)', async () => {
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

  it('admits an Origin from YAAC_ALLOWED_HOSTS (read per request)', async () => {
    const app = appWithOriginCheck()
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      const ok = await app.request('/x', { headers: { origin: 'https://srv.tailnet.ts.net' } })
      expect(ok.status).toBe(200)
      const other = await app.request('/x', { headers: { origin: 'https://evil.com' } })
      expect(other.status).toBe(403)
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

  it('allows a request with no Sec-Fetch-Site (CLI, older browser)', async () => {
    const res = await appWithFetchSiteCheck().request('/x')
    expect(res.status).toBe(200)
  })

  it('allows same-origin requests (the SPA)', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a cross-site request with BAD_FETCH_SITE', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_FETCH_SITE')
  })

  it('allows a cross-site top-level document navigation', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a cross-site embedded (iframe) navigation', async () => {
    const res = await appWithFetchSiteCheck().request('/x', {
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    })
    expect(res.status).toBe(403)
  })
})
