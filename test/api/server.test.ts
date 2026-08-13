import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('buildApp', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    consoleErrorSpy.mockClear()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
    vi.unstubAllEnvs()
  })

  it('GET /health returns buildId + ok without auth', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'abc123' })
    // /health is the auth-exempt probe; hit it with a bare request
    // (no bearer) to prove the exemption still holds. A loopback server is
    // credential-optional by default, so it reports authRequired: false.
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    // `driver` is 'k8s' here: this project's setup registers the real one
    // (cluster-setup.ts), standing in for the composition root.
    expect(await res.json())
      .toEqual({ ok: true, buildId: 'abc123', ready: true, authRequired: false, driver: 'k8s' })
  })

  it('GET /project/list requires bearer auth', async () => {
    // A loopback server is credential-optional by default; force the gate on
    // to assert the bearer requirement.
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    const app = buildApp({ secret: 'shh', buildId: 'test-build-id' })
    const res = await app.request('/project/list')
    expect(res.status).toBe(401)
  })

  it('GET /project/list returns [] on a fresh data dir', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test-build-id' }))
    const res = await client.project.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('unknown routes return uniform 404 NOT_FOUND', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'test-build-id' })
    // Unknown routes aren't in AppType, so the typed client can't
    // reach them — fall back to a raw app.request.
    const res = await app.request('/no/such/route', {
      headers: { authorization: 'Bearer shh' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no route GET /no/such/route' },
    })
  })

  it('handler exceptions are mapped to the uniform error body', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'test-build-id' })
    app.get('/boom', () => { throw new Error('kaboom') })
    const res = await app.request('/boom', { headers: { authorization: 'Bearer shh' } })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('kaboom')
  })
})
