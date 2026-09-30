import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { denyBrowserCors, requestLogger } from '@yaac/server/http/auth'
import { identify, type IdentityEnv } from '@yaac/server/http'
import { asTailnet } from '@yaac/test-utils/api'

function buildTestApp(): Hono {
  const app = new Hono()
  app.use('*', denyBrowserCors())
  app.get('/protected', (c) => c.text('protected ok'))
  return app
}

// The identity gate is covered in
// packages/server/test/api/http/web-auth.test.ts.

describe('denyBrowserCors', () => {
  it('responds 405 to preflight (OPTIONS) requests', async () => {
    const res = await buildTestApp().request('/protected', { method: 'OPTIONS' })
    expect(res.status).toBe(405)
  })
})

describe('requestLogger', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  afterEach(() => {
    consoleErrorSpy.mockClear()
  })

  it('logs method, path, status, and duration — never the body', async () => {
    const app = new Hono()
    app.use('*', requestLogger())
    app.post('/echo', async (c) => {
      const body = await c.req.text()
      return c.text(`got: ${body}`, 200)
    })
    const res = await app.request('/echo', { method: 'POST', body: 'super-secret-value' })
    expect(res.status).toBe(200)
    expect(consoleErrorSpy).toHaveBeenCalled()
    const logged = consoleErrorSpy.mock.calls[0][0] as string
    expect(logged).toContain('POST')
    expect(logged).toContain('/echo')
    expect(logged).toContain('200')
    expect(logged).not.toContain('super-secret-value')
  })

  it('names the tailnet user a request came from, and nobody for a local one', async () => {
    // The log line is the audit trail of which person did what.
    const app = new Hono<IdentityEnv>()
    app.use('*', requestLogger())
    app.use('*', identify())
    app.get('/x', (c) => c.text('ok'))
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    try {
      await app.request('/x', { headers: asTailnet('alice@example.com', 'srv.tailnet.ts.net') })
      await app.request('/x')
    } finally {
      vi.unstubAllEnvs()
    }
    const [tailnet, local] = consoleErrorSpy.mock.calls.map((c) => String(c[0]))
    expect(tailnet).toMatch(/GET \/x 200 \d+ms alice@example\.com$/)
    expect(local).toMatch(/GET \/x 200 \d+ms$/)
  })
})
