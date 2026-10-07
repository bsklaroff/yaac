import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import {
  fetchSiteCheck,
  hostHeaderCheck,
  identify,
  originHeaderCheck,
  type IdentityEnv,
} from '#http'
import { BUILT_IN_USER_ID, closeDb } from '#db'
import { asTailnet } from '@yaac/test-utils/api'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { AccessMode } from '@yaac/shared/types'

/**
 * The identity gate over the paths that split public from identified (SPA
 * shell and assets, health probe, an ordinary API route), with a
 * `/api/whoami` reporting the gate's decision, in the given access mode
 * (null: not settled yet).
 */
function appWithIdentity(mode: AccessMode | null = 'local'): Hono<IdentityEnv> {
  const app = new Hono<IdentityEnv>()
  app.use('*', identify(() => mode ?? undefined))
  app.get('/api/health', (c) => c.text('ok'))
  app.get('/', (c) => c.text('shell'))
  app.get('/assets/*', (c) => c.text('asset'))
  app.get('/api/whoami', (c) => c.json(c.get('principal')))
  app.post('/api/workspace/mama', (c) => c.text('mama'))
  return app
}

async function refusal(res: Response): Promise<string> {
  expect(res.status).toBe(401)
  const body = await res.json() as { error: { code: string; message: string } }
  expect(body.error.code).toBe('UNAUTHENTICATED')
  return body.error.message
}

const LOCAL = { kind: 'local', userId: BUILT_IN_USER_ID }

describe('identify', () => {
  // Tailnet callers are upserted as users.
  let tmpDir: string
  beforeAll(async () => { tmpDir = await createTempDataDir() })
  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('lets the shell, its assets and health through with no identity at all', async () => {
    // Public so an unidentified browser can load the app and be told why,
    // even before startup has settled the access mode.
    for (const mode of ['local', 'tailnet', null] as const) {
      const app = appWithIdentity(mode)
      const bare = { host: 'srv.tailnet.ts.net' }
      for (const path of ['/api/health', '/', '/assets/index-abc.js']) {
        expect((await app.request(path, { headers: bare })).status).toBe(200)
      }
      expect((await app.request('/api/whoami', { headers: bare })).status).toBe(mode === null ? 503 : 401)
    }
  })

  // Every row of the identity rule in local mode, under a top-level server
  // and then under one inside a workspace — which differ in exactly one row.
  for (const workspace of [false, true]) {
    describe(workspace ? 'local mode, inside a workspace' : 'local mode, top-level', () => {
      const setup = (): Hono<IdentityEnv> => {
        if (workspace) vi.stubEnv('YAAC_WORKSPACE_ID', 'abcd1234')
        return appWithIdentity('local')
      }

      it('an unproxied request to loopback is the built-in user', async () => {
        const app = setup()
        for (const host of ['127.0.0.1:8787', 'localhost']) {
          const res = await app.request('/api/whoami', { headers: { host } })
          expect(await res.json()).toEqual(LOCAL)
        }
      })

      it('a request through serve is refused, even with a user', async () => {
        const res = await setup().request('/api/whoami', {
          headers: asTailnet('alice@example.com', 'srv.tailnet.ts.net'),
        })
        expect(await refusal(res)).toMatch(/runs in local mode.*--tailnet/s)
      })

      it('a proxied request with no user is refused, naming tagged devices and Funnel', async () => {
        const res = await setup().request('/api/whoami', { headers: asTailnet(null, 'srv.tailnet.ts.net') })
        expect(await refusal(res)).toMatch(/no user identity.*tagged device.*Funnel/s)
      })

      it(workspace
        ? 'an unproxied request to another name is local — the outer install\'s forward'
        : 'an unproxied request to another name is refused, failing closed', async () => {
        const res = await setup().request('/api/whoami', { headers: { host: 'srv.tailnet.ts.net:9787' } })
        if (workspace) expect(await res.json()).toEqual(LOCAL)
        else expect(await refusal(res)).toMatch(/reached as srv\.tailnet\.ts\.net without tailscale serve/)
      })
    })
  }

  it('ignores an empty YAAC_WORKSPACE_ID', async () => {
    vi.stubEnv('YAAC_WORKSPACE_ID', '')
    const res = await appWithIdentity().request('/api/whoami', { headers: { host: 'srv.tailnet.ts.net' } })
    expect(res.status).toBe(401)
  })

  describe('tailnet mode', () => {
    const app = (): Hono<IdentityEnv> => appWithIdentity('tailnet')

    it('a request serve stamped with a user is that tailnet user, the same user every time', async () => {
      const first = await (await app().request('/api/whoami', {
        headers: asTailnet('alice@example.com', 'srv.tailnet.ts.net'),
      })).json() as { userId: string }
      expect(first).toEqual({ kind: 'tailnet', login: 'alice@example.com', name: 'alice', userId: expect.any(String) as unknown })
      expect(first.userId).not.toBe(BUILT_IN_USER_ID)
      const again = await (await app().request('/api/whoami', {
        headers: asTailnet('alice@example.com', 'srv.tailnet.ts.net'),
      })).json() as { userId: string }
      expect(again.userId).toBe(first.userId)
      const bob = await (await app().request('/api/whoami', {
        headers: asTailnet('bob@example.com', 'srv.tailnet.ts.net'),
      })).json() as { userId: string }
      expect(bob.userId).not.toBe(first.userId)
    })

    it('refuses loopback, naming the mode', async () => {
      const res = await app().request('/api/whoami', { headers: { host: '127.0.0.1' } })
      expect(await refusal(res)).toMatch(/runs in tailnet mode.*tailscale serve/s)
    })

    it('still refuses serve with no user', async () => {
      const res = await app().request('/api/whoami', { headers: asTailnet(null, 'srv.tailnet.ts.net') })
      expect(await refusal(res)).toMatch(/tagged device/)
    })

    it('lets a containerless yaac-mama post through over loopback, for its route to authenticate', async () => {
      const res = await app().request('/api/workspace/mama', { method: 'POST', headers: { host: '127.0.0.1' } })
      expect(await res.text()).toBe('mama')
      // Only that route, and only the POST it serves.
      expect((await app().request('/api/workspace/mama', { headers: { host: '127.0.0.1' } })).status).toBe(401)
    })

    it('proxying is recognized by any identity header, and forged loopback Hosts do not matter', async () => {
      // A local process sending only a user header, or a proxied request
      // naming loopback: either way the request is judged as proxied.
      const named = await app().request('/api/whoami', {
        headers: { host: '127.0.0.1', 'tailscale-user-login': 'bob@x' },
      })
      expect(await named.json()).toMatchObject({ kind: 'tailnet', login: 'bob@x' })
      const nameless = await app().request('/api/whoami', {
        headers: { host: '127.0.0.1', 'tailscale-user-name': 'Bob' },
      })
      expect(nameless.status).toBe(401)
    })

    it('decodes a non-ASCII identity serve sent as an RFC 2047 encoded word', async () => {
      const res = await app().request('/api/whoami', {
        headers: {
          ...asTailnet('jose@example.com', 'srv.tailnet.ts.net'),
          'tailscale-user-name': '=?utf-8?q?Jos=C3=A9_Garc=C3=ADa?=',
        },
      })
      expect(await res.json()).toMatchObject({ name: 'José García' })
    })

    it('decodes a value split across several encoded words, and drops control characters', async () => {
      // Long values are split into several space-separated encoded words, and
      // the decoded text goes into log lines, so CR/LF or ESC must not
      // survive.
      const res = await app().request('/api/whoami', {
        headers: {
          host: 'srv.tailnet.ts.net',
          'x-forwarded-for': '100.64.0.7',
          'tailscale-user-login': '=?utf-8?q?mallory=0D=0A=1B[31m@example.com?=',
          'tailscale-user-name': '=?utf-8?q?Zo=C3=AB_=C3=85ngstr=C3=B6m-?= =?utf-8?q?=C3=98resund_=C5=81ukasiewicz?=',
        },
      })
      expect(await res.json()).toMatchObject({
        kind: 'tailnet', login: 'mallory[31m@example.com', name: 'Zoë Ångström-Øresund Łukasiewicz',
      })
    })
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

  it('allows exactly the origin the request was sent to', async () => {
    // The SPA's own requests: same scheme, host and port, both at loopback
    // and at a tailnet name behind serve (Host preserved, scheme from serve,
    // default port optional).
    const app = appWithOriginCheck()
    const same: Array<Record<string, string>> = [
      { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' },
      { host: 'localhost:8787', origin: 'http://LOCALHOST:8787' },
      { host: 'srv.tailnet.ts.net', origin: 'https://srv.tailnet.ts.net', 'x-forwarded-proto': 'https' },
      { host: 'srv.tailnet.ts.net:443', origin: 'https://srv.tailnet.ts.net', 'x-forwarded-proto': 'https' },
    ]
    for (const headers of same) {
      expect((await app.request('/x', { headers })).status, JSON.stringify(headers)).toBe(200)
    }
  })

  it('rejects a page on the same hostname at another port — a forwarded dev server', async () => {
    // What `yaac forward` and the desktop preview put on the server's own
    // hostname, running untrusted repo code.
    const app = appWithOriginCheck()
    const forwarded: Array<Record<string, string>> = [
      { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:19500' },
      { host: '127.0.0.1:8787', origin: 'http://localhost:8787' },
      { host: 'srv.tailnet.ts.net', origin: 'http://srv.tailnet.ts.net:19500', 'x-forwarded-proto': 'https' },
      // Same host and default port, the other scheme: a forward on :80.
      { host: 'srv.tailnet.ts.net', origin: 'http://srv.tailnet.ts.net', 'x-forwarded-proto': 'https' },
      // And an https page reaching the plain listener directly.
      { host: '127.0.0.1:8787', origin: 'https://127.0.0.1:8787' },
    ]
    for (const headers of forwarded) {
      expect((await app.request('/x', { headers })).status, JSON.stringify(headers)).toBe(403)
    }
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
    // but carries no host, which is never the request's own.
    for (const origin of ['null', 'not a url', 'foo:bar']) {
      const res = await appWithOriginCheck().request('/x', { headers: { origin } })
      expect(res.status).toBe(403)
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
