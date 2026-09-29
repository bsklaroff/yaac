import { describe, it, expect } from 'vitest'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { buildApp } from '#main/server'

describe('GET /health', () => {
  it('reports ok, the buildId, and the driver', async () => {
    installFakeWorktreeDriver()
    const app = buildApp({ buildId: 'bid-1' })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json())
      .toEqual({ ok: true, buildId: 'bid-1', ready: true, driver: 'k8s' })
  })

  it('reports a null driver rather than failing when none is registered', async () => {
    // /health is what a caller probes before it knows anything about the
    // server, including whether its substrate came up — so it must answer
    // during the window before the composition root has registered one.
    const app = buildApp({ buildId: 'b' })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect((await res.json() as { driver: string | null }).driver).toBeNull()
  })

  it('defaults ready to true when no isReady is injected (in-process tests)', async () => {
    const app = buildApp({ buildId: 'b' })
    const res = await app.request('/api/health')
    expect((await res.json() as { ready: boolean }).ready).toBe(true)
  })

  it('reflects the injected isReady, reading it live on each request', async () => {
    // The runServer wiring passes `() => ready`, a flag flipped true only
    // after DB init — so /health must call it per request, not cache it.
    let ready = false
    const app = buildApp({ buildId: 'b', isReady: () => ready })

    const before = await app.request('/api/health')
    expect((await before.json() as { ready: boolean }).ready).toBe(false)

    ready = true
    const after = await app.request('/api/health')
    expect((await after.json() as { ready: boolean }).ready).toBe(true)
  })
})
