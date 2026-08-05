import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

// The retry route wires HTTP → retryImageBuild and owns the sidecar rebuild
// for an infra build. The feature's own forget/re-fire behavior is unit-tested
// in features/images/image-prewarm.test.ts; mock both leaves here so the route
// test stays hermetic and doesn't pull in the proxy client's k8s deps.
vi.mock('#features/images/image-prewarm', () => ({ retryImageBuild: vi.fn() }))
const { ensureRunning } = vi.hoisted(() => ({ ensureRunning: vi.fn().mockResolvedValue(undefined) }))
vi.mock('#features/egress', () => ({ proxyClient: { ensureRunning } }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { imageApp } from '#routes/images'
import { toErrorBody } from '#http'
import { retryImageBuild } from '#features/images/image-prewarm'
import {
  clearAllImageBuildsForTests,
  failImageBuild,
  ingestImageBuildLine,
  registerImageBuild,
} from '#features/image-engine/image-builds'
import type { ImageBuildEntry } from '@yaac/shared/types'

// The log route throws NOT_FOUND; only the root app's onError serializes it,
// so exercise the routes through a wrapper that installs the same handler.
const app = new Hono()
  .onError((err, c) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })
  .route('/', imageApp)

function register(): string {
  return registerImageBuild({
    tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'p', reason: 'session',
  })
}

describe('image routes', () => {
  beforeEach(() => { clearAllImageBuildsForTests(); vi.clearAllMocks() })
  afterEach(() => { clearAllImageBuildsForTests() })

  it('GET /builds lists registry entries', async () => {
    const id = register()
    const res = await app.request('/builds')
    expect(res.status).toBe(200)
    const body = await res.json() as ImageBuildEntry[]
    expect(body.map((b) => b.id)).toEqual([id])
  })

  it('GET /builds/:id/log returns the accumulated tail', async () => {
    const id = register()
    ingestImageBuildLine(id, 'STEP 1/2: FROM ubuntu')
    const res = await app.request(`/builds/${id}/log`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ log: 'STEP 1/2: FROM ubuntu\n' })
  })

  it('GET /builds/:id/log 404s for an unknown id', async () => {
    const res = await app.request('/builds/nope/log')
    expect(res.status).toBe(404)
  })

  it('DELETE /builds/:id dismisses a finished entry', async () => {
    const id = register()
    failImageBuild(id, 'boom')
    const res = await app.request(`/builds/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const list = await (await app.request('/builds')).json() as ImageBuildEntry[]
    expect(list).toEqual([])
  })

  it('DELETE /builds/:id leaves a running entry in place', async () => {
    const id = register()
    const res = await app.request(`/builds/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const list = await (await app.request('/builds')).json() as ImageBuildEntry[]
    expect(list.map((b) => b.id)).toEqual([id])
  })

  it('POST /builds/:id/retry retries and returns 202', async () => {
    ensureRunning.mockResolvedValue(undefined)
    vi.mocked(retryImageBuild).mockReturnValue({ retried: true, infra: false })
    const res = await app.request('/builds/build-1/retry', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(vi.mocked(retryImageBuild)).toHaveBeenCalledWith('build-1')
    // A project build is re-fired by the feature; the route stays out of it.
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  it('POST /builds/:id/retry rebuilds the proxy sidecar for an infra build', async () => {
    ensureRunning.mockResolvedValue(undefined)
    vi.mocked(retryImageBuild).mockReturnValue({ retried: true, infra: true })
    const res = await app.request('/builds/build-1/retry', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('POST /builds/:id/retry 404s when there is nothing to retry', async () => {
    ensureRunning.mockResolvedValue(undefined)
    vi.mocked(retryImageBuild).mockReturnValue({ retried: false, infra: false })
    const res = await app.request('/builds/nope/retry', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(ensureRunning).not.toHaveBeenCalled()
  })
})
