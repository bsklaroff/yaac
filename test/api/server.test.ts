import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { workspaceDriver } from '@yaac/server/drivers/driver'

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
    const app = buildApp({ buildId: 'abc123' })
    // /health is exempt from the identity check, so it answers even at a
    // name with no identity.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    const res = await app.request('/api/health', { headers: { host: 'srv.tailnet.ts.net' } })
    expect(res.status).toBe(200)
    // `driver` reports whichever driver the project's setup registered
    // (k8s under `api-k8s`, containerless under `api-containerless`).
    expect(await res.json()).toEqual({
      ok: true,
      buildId: 'abc123',
      ready: true,
      access: 'local',
      driver: workspaceDriver().kind,
    })
  })

  it('GET /project/list requires an identity', async () => {
    // A tailnet name reached without tailscale serve has none.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    const app = buildApp({ buildId: 'test-build-id' })
    const res = await app.request('/api/project/list', { headers: { host: 'srv.tailnet.ts.net' } })
    expect(res.status).toBe(401)
  })

  it('GET /project/list returns [] on a fresh data dir', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test-build-id' }))
    const res = await client.project.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('unknown routes return uniform 404 NOT_FOUND', async () => {
    const app = buildApp({ buildId: 'test-build-id' })
    // The typed client can't reach an unknown route.
    const res = await app.request('/no/such/route')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no route GET /no/such/route' },
    })
  })

  it('handler exceptions are mapped to the uniform error body', async () => {
    const app = buildApp({ buildId: 'test-build-id' })
    app.get('/boom', () => { throw new Error('kaboom') })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('kaboom')
  })

  it('refuses an oversized upload that declares no length, by counting it', async () => {
    // A chunked body takes bodyLimit's streaming branch; the e2e suite
    // covers the declared-length one.
    const app = buildApp({ buildId: 'test-build-id' })
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await app.request('/api/workspace/00000000-0000-4000-8000-000000000001/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { code: 'TOO_LARGE' } })
  })
})
