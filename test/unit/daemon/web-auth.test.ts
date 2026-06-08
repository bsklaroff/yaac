import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  cookieOrBearerAuth,
  createWebAuthStore,
  hostHeaderCheck,
  isAllowedHost,
  isPublicPath,
  SESSION_COOKIE,
} from '@/daemon/web-auth'

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

  it('revokeAll invalidates every session', () => {
    const store = createWebAuthStore()
    const sid = store.consumeBootstrap(store.currentCode()) as string
    expect(store.isValidSession(sid)).toBe(true)
    store.revokeAll()
    expect(store.isValidSession(sid)).toBe(false)
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
  it('allows loopback hostnames with the bound port', () => {
    expect(isAllowedHost('127.0.0.1:5000', 5000)).toBe(true)
    expect(isAllowedHost('localhost:5000', 5000)).toBe(true)
  })

  it('allows a loopback hostname without a port', () => {
    expect(isAllowedHost('localhost', 5000)).toBe(true)
  })

  it('rejects non-loopback hostnames (DNS rebinding)', () => {
    expect(isAllowedHost('evil.com:5000', 5000)).toBe(false)
    expect(isAllowedHost('evil.com', 5000)).toBe(false)
    expect(isAllowedHost('', 5000)).toBe(false)
  })

  it('rejects a wrong port when the bound port is known', () => {
    expect(isAllowedHost('127.0.0.1:9999', 5000)).toBe(false)
  })

  it('skips the port check when not bound yet (port 0)', () => {
    expect(isAllowedHost('127.0.0.1:9999', 0)).toBe(true)
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

  it('rejects a wrong bearer', async () => {
    const res = await appWithAuth().app.request('/session/list', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
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

describe('hostHeaderCheck', () => {
  function appWithHostCheck(port: number): Hono {
    const app = new Hono()
    app.use('*', hostHeaderCheck(() => port))
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('allows loopback hosts', async () => {
    const res = await appWithHostCheck(0).request('/x', { headers: { host: '127.0.0.1' } })
    expect(res.status).toBe(200)
  })

  it('rejects a non-loopback host', async () => {
    const res = await appWithHostCheck(0).request('http://evil.com/x', {
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_HOST')
  })
})
