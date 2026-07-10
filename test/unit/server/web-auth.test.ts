import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import {
  constantTimeEqual,
  cookieOrBearerAuth,
  createWebAuthStore,
  hostHeaderCheck,
  isAllowedHost,
  isPublicPath,
  MAX_SESSIONS,
  SESSION_COOKIE,
} from '@/server/web-auth'

describe('createWebAuthStore', () => {
  it('exchanges the current code for a session id and rotates the code', () => {
    const store = createWebAuthStore()
    const code = store.currentCode()
    const sid = store.consumeBootstrap(code)
    expect(sid).toBeTypeOf('string')
    expect(store.isValidSession(sid as string)).toBe(true)
    // Single-use: the code is rotated, so the old value no longer works.
    expect(store.currentCode()).not.toBe(code)
    expect(store.consumeBootstrap(code)).toBeNull()
  })

  it('rejects a mismatched code', () => {
    const store = createWebAuthStore()
    expect(store.consumeBootstrap('not-the-code')).toBeNull()
  })

  it('rejects a code older than the TTL', () => {
    const store = createWebAuthStore({ ttlMs: 1000, now: () => 0 })
    const code = store.currentCode()
    expect(store.consumeBootstrap(code, 1001)).toBeNull()
    // Within the window still works.
    expect(store.consumeBootstrap(code, 1000)).toBeTypeOf('string')
  })

  it('mints distinct session ids and validates only minted ones', () => {
    const store = createWebAuthStore()
    const a = store.consumeBootstrap(store.currentCode())
    const b = store.consumeBootstrap(store.currentCode())
    expect(a).not.toBe(b)
    expect(store.isValidSession('never-minted')).toBe(false)
  })

  it('restores initialSessions (persistence across restart)', () => {
    const store = createWebAuthStore({ initialSessions: ['restored-id'] })
    expect(store.isValidSession('restored-id')).toBe(true)
    expect(store.isValidSession('other')).toBe(false)
  })

  it('notifies onSessionsChanged when sessions are minted', () => {
    const snapshots: string[][] = []
    const store = createWebAuthStore({ onSessionsChanged: (s) => snapshots.push(s) })
    const sid = store.consumeBootstrap(store.currentCode()) as string
    expect(snapshots.at(-1)).toContain(sid)
  })

  it('caps retained sessions at MAX_SESSIONS, evicting the oldest', () => {
    let latest: string[] = []
    const store = createWebAuthStore({ onSessionsChanged: (s) => { latest = s } })
    const ids: string[] = []
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      const id = store.consumeBootstrap(store.currentCode())
      if (id) ids.push(id)
    }
    expect(latest).toHaveLength(MAX_SESSIONS)
    expect(store.isValidSession(ids[0])).toBe(false) // oldest evicted
    expect(store.isValidSession(ids[ids.length - 1])).toBe(true) // newest kept
  })
})

describe('isPublicPath', () => {
  it('allows the SPA shell, assets, health, and bootstrap', () => {
    expect(isPublicPath('/')).toBe(true)
    expect(isPublicPath('/assets/index-abc.js')).toBe(true)
    expect(isPublicPath('/health')).toBe(true)
    expect(isPublicPath('/auth/bootstrap')).toBe(true)
  })

  it('does not allow API paths', () => {
    expect(isPublicPath('/session/list')).toBe(false)
    expect(isPublicPath('/auth/list')).toBe(false)
    expect(isPublicPath('/events')).toBe(false)
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

function appWithAuth(): { app: Hono; store: ReturnType<typeof createWebAuthStore> } {
  const store = createWebAuthStore()
  const app = new Hono()
  app.use('*', cookieOrBearerAuth('shh', store))
  app.get('/health', (c) => c.text('ok'))
  app.get('/session/list', (c) => c.text('protected ok'))
  return { app, store }
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

  it('accepts a durable token bearer when a token store is wired', async () => {
    const store = createWebAuthStore()
    const app = new Hono()
    app.use('*', cookieOrBearerAuth('shh', store, { isValidToken: (t) => t === 'durable' }))
    app.get('/session/list', (c) => c.text('protected ok'))

    const ok = await app.request('/session/list', {
      headers: { authorization: 'Bearer durable' },
    })
    expect(ok.status).toBe(200)

    const bad = await app.request('/session/list', {
      headers: { authorization: 'Bearer other' },
    })
    expect(bad.status).toBe(401)
    const body = await bad.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
  })

  it('lets a valid cookie override a stale bearer', async () => {
    const { app, store } = appWithAuth()
    const sid = store.consumeBootstrap(store.currentCode()) as string
    const res = await app.request('/session/list', {
      headers: {
        authorization: 'Bearer stale',
        cookie: `${SESSION_COOKIE}=${sid}`,
      },
    })
    expect(res.status).toBe(200)
  })

  it('accepts a valid session cookie and rejects an invalid one', async () => {
    const { app, store } = appWithAuth()
    const sid = store.consumeBootstrap(store.currentCode()) as string
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
})

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects unequal ones', () => {
    expect(constantTimeEqual('secret', 'secret')).toBe(true)
    expect(constantTimeEqual('secret', 'secreT')).toBe(false)
  })

  it('rejects length mismatches without throwing', () => {
    expect(constantTimeEqual('short', 'longer-value')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
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
