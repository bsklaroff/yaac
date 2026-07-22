import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildApp } from '#main/server'

describe('GET /health', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reports ok, the buildId, and authRequired', async () => {
    // A loopback test server is credential-optional by default; force the gate
    // on to see authRequired: true.
    vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
    const app = buildApp({ secret: 'shh', buildId: 'bid-1' })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, buildId: 'bid-1', ready: true, authRequired: true })
  })

  it('reports authRequired: false for a credential-optional (loopback) server', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/health')
    expect((await res.json() as { authRequired: boolean }).authRequired).toBe(false)
  })

  it('defaults ready to true when no isReady is injected (in-process tests)', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/health')
    expect((await res.json() as { ready: boolean }).ready).toBe(true)
  })

  it('reflects the injected isReady, reading it live on each request', async () => {
    // The runServer wiring passes `() => ready`, a flag flipped true only
    // after DB init — so /health must call it per request, not cache it.
    let ready = false
    const app = buildApp({ secret: 'shh', buildId: 'b', isReady: () => ready })

    const before = await app.request('/health')
    expect((await before.json() as { ready: boolean }).ready).toBe(false)

    ready = true
    const after = await app.request('/health')
    expect((await after.json() as { ready: boolean }).ready).toBe(true)
  })
})
