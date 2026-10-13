import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// The log sink is a process boundary (stderr + an append to server.log).
const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#lib/log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import { denyBrowserCors, requestLogger } from '#api/http/auth'
import { identify, type IdentityEnv } from '#api/http/web-auth'
import { closeDb } from '#db'
import { asTailnet } from '@yaac/test-utils/api'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { AccessMode } from '@yaac/shared/types'

describe('denyBrowserCors', () => {
  function app(): Hono {
    const app = new Hono()
    app.use('*', denyBrowserCors())
    app.get('/x', (c) => c.text('ok'))
    app.post('/x', (c) => c.json({ ok: true }, 201))
    app.options('/x', (c) => c.text('handler should never run'))
    return app
  }

  it('refuses a preflight with 405 and an empty body, without reaching the route', async () => {
    const res = await app().request('/x', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.com',
        'access-control-request-method': 'POST',
      },
    })
    expect(res.status).toBe(405)
    expect(await res.text()).toBe('')
    // No CORS grant of any kind — a browser cannot follow up with the real request.
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('passes every other method through, Origin and all', async () => {
    const get = await app().request('/x', { headers: { origin: 'https://evil.com' } })
    expect(get.status).toBe(200)
    // Judging the Origin itself is originHeaderCheck's job, not this guard's.
    const post = await app().request('/x', { method: 'POST' })
    expect(post.status).toBe(201)
  })
})

describe('requestLogger', () => {
  beforeEach(() => mockServerLog.mockClear())

  function app(): Hono {
    const app = new Hono()
    app.use('*', requestLogger())
    app.post('/echo', async (c) => c.json(await c.req.json(), 201))
    app.get('/boom', (c) => c.json({ error: 'nope' }, 500))
    return app
  }

  it('logs method, path, final status and duration once the handler has run', async () => {
    const res = await app().request('/boom')
    expect(res.status).toBe(500)
    expect(mockServerLog).toHaveBeenCalledTimes(1)
    // The status is the response's, so it is only knowable after next().
    expect(mockServerLog.mock.calls[0][0]).toMatch(/^\[server\] GET \/boom 500 \d+ms$/)
  })

  it('never logs request or response bodies', async () => {
    await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret' },
      body: JSON.stringify({ password: 'hunter2' }),
    })
    const line = mockServerLog.mock.calls[0][0] as string
    expect(line).toMatch(/^\[server\] POST \/echo 201 \d+ms$/)
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('super-secret')
  })

  it('names the tailnet user a request came from, and nobody for a local one', async () => {
    // The log line is the audit trail of which person did what.
    const app = (mode: AccessMode): Hono<IdentityEnv> => {
      const a = new Hono<IdentityEnv>()
      a.use('*', requestLogger())
      a.use('*', identify(() => mode))
      a.get('/x', (c) => c.text('ok'))
      return a
    }
    const tmpDir = await createTempDataDir()
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      await app('tailnet').request('/x', { headers: asTailnet('alice@example.com', 'srv.tailnet.ts.net') })
      await app('local').request('/x')
    } finally {
      vi.unstubAllEnvs()
      await closeDb()
      await cleanupTempDir(tmpDir)
    }
    const [tailnet, local] = mockServerLog.mock.calls.map((c) => String(c[0]))
    expect(tailnet).toMatch(/GET \/x 200 \d+ms alice@example\.com$/)
    expect(local).toMatch(/GET \/x 200 \d+ms$/)
  })
})
