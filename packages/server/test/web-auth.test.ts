import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import {
  timingSafeStrEqual,
  cookieOrBearerAuth,
  hostHeaderCheck,
  isAllowedHost,
  isPublicPath,
  SESSION_COOKIE,
} from '#web-auth'
import { createTokenStore } from '#token-store'

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
        cookie: `${SESSION_COOKIE}=${sid}`,
      },
    })
    expect(res.status).toBe(200)
  })

  it('accepts a valid session cookie and rejects an invalid one', async () => {
    const { app, tokens } = appWithAuth()
    const sid = mintSession(tokens)
    expect(sid.length).toBeGreaterThan(0)

    const ok = await app.request('/session/list', {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    })
    expect(ok.status).toBe(200)

    const bad = await app.request('/session/list', {
      headers: { cookie: `${SESSION_COOKIE}=bogus` },
    })
    expect(bad.status).toBe(401)
  })

  it('rejects a durable token presented as a cookie', async () => {
    const { app, tokens } = appWithAuth()
    const entry = tokens.create('laptop')
    const res = await app.request('/session/list', {
      headers: { cookie: `${SESSION_COOKIE}=${entry.token}` },
    })
    expect(res.status).toBe(401)
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
