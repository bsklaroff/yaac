import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { bearerAuth, denyBrowserCors, requestLogger } from '@/lib/daemon/auth'

function buildTestApp(secret = 'shh'): Hono {
  const app = new Hono()
  app.use('*', denyBrowserCors())
  app.use('*', bearerAuth(secret))
  app.get('/health', (c) => c.text('ok'))
  app.get('/protected', (c) => c.text('protected ok'))
  return app
}

describe('bearerAuth', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await buildTestApp().request('/protected')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
  })

  it('rejects requests with the wrong secret', async () => {
    const res = await buildTestApp().request('/protected', {
      headers: { authorization: 'Bearer not-the-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with the correct secret', async () => {
    const res = await buildTestApp().request('/protected', {
      headers: { authorization: 'Bearer shh' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('protected ok')
  })

  it('accepts the bearer scheme case-insensitively', async () => {
    const res = await buildTestApp().request('/protected', {
      headers: { authorization: 'bearer shh' },
    })
    expect(res.status).toBe(200)
  })

  it('exempts /health so the CLI can probe without the secret', async () => {
    const res = await buildTestApp().request('/health')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('rejects when secret-length matches but bytes differ', async () => {
    // Length-equal mismatch exercises the constant-time branch.
    const res = await buildTestApp('abc').request('/protected', {
      headers: { authorization: 'Bearer xyz' },
    })
    expect(res.status).toBe(401)
  })
})

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
