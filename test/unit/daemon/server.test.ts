import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { buildApp } from '@/lib/daemon/server'

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('buildApp', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    consoleErrorSpy.mockClear()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('GET /health returns version + ok without auth', async () => {
    const app = buildApp({ secret: 'shh', version: '9.9.9' })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: '9.9.9' })
  })

  it('GET /project/list requires bearer auth', async () => {
    const app = buildApp({ secret: 'shh', version: '0.0.1' })
    const res = await app.request('/project/list')
    expect(res.status).toBe(401)
  })

  it('GET /project/list returns [] on a fresh data dir', async () => {
    const app = buildApp({ secret: 'shh', version: '0.0.1' })
    const res = await app.request('/project/list', {
      headers: { authorization: 'Bearer shh' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('unknown routes return uniform 404 NOT_FOUND', async () => {
    const app = buildApp({ secret: 'shh', version: '0.0.1' })
    const res = await app.request('/no/such/route', {
      headers: { authorization: 'Bearer shh' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no route GET /no/such/route' },
    })
  })

  it('handler exceptions are mapped to the uniform error body', async () => {
    const app = buildApp({ secret: 'shh', version: '0.0.1' })
    app.get('/boom', () => { throw new Error('kaboom') })
    const res = await app.request('/boom', { headers: { authorization: 'Bearer shh' } })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('kaboom')
  })
})
