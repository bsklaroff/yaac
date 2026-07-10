import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { denyBrowserCors, requestLogger } from '@/server/auth'

function buildTestApp(): Hono {
  const app = new Hono()
  app.use('*', denyBrowserCors())
  app.get('/protected', (c) => c.text('protected ok'))
  return app
}

// Bearer + cookie auth moved to `@/server/web-auth`; see
// test/unit/server/web-auth.test.ts for that coverage.

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
})
