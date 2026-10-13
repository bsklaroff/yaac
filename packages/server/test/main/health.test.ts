import { beforeEach, describe, it, expect } from 'vitest'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { buildApp } from '#main/server'

describe('GET /health', () => {
  beforeEach(() => { installFakeWorkspaceDriver() })

  it('reports ok, the buildId, the access mode, and the driver', async () => {
    const app = buildApp({ buildId: 'bid-1' })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json())
      .toEqual({ ok: true, buildId: 'bid-1', ready: true, access: 'local', driver: 'k8s' })
  })

  it('defaults ready to true when no isReady is injected (in-process tests)', async () => {
    const app = buildApp({ buildId: 'b' })
    const res = await app.request('/api/health')
    expect((await res.json() as { ready: boolean }).ready).toBe(true)
  })

  it('reflects the injected isReady, reading it live on each request', async () => {
    // runServer's flag flips after DB init, so it must not be cached.
    let ready = false
    const app = buildApp({ buildId: 'b', isReady: () => ready })

    const before = await app.request('/api/health')
    expect((await before.json() as { ready: boolean }).ready).toBe(false)

    ready = true
    const after = await app.request('/api/health')
    expect((await after.json() as { ready: boolean }).ready).toBe(true)
  })

  it('reports why a start was refused, and nothing but public paths answer until the mode settles', async () => {
    const app = buildApp({ buildId: 'b', isReady: () => false, access: () => ({ refused: 'no' }) })
    expect(await (await app.request('/api/health')).json())
      .toMatchObject({ ready: false, access: null, refused: 'no' })
    const whoami = await app.request('/api/whoami')
    expect(whoami.status).toBe(503)
    expect(await whoami.text()).toContain('the server refused to start: no')
  })
})
