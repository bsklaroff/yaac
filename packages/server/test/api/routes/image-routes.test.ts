import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as imagePrewarmModule from '#runtime/k8s/images/image-prewarm'
import { Hono } from 'hono'

// These routes are pure translation: HTTP in, one feature call out, and a
// 404 for an id they do not know. The real registry stands behind the read
// routes (so a case asserts on entries it registered); the retry outcome is
// dictated, and the proxy kick an infra retry fires is asserted here because
// the route owns that composition.
vi.mock('#runtime/k8s/images/image-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof imagePrewarmModule>()),
  retryImageBuild: vi.fn(),
}))
const { ensureRunning } = vi.hoisted(() => ({
  ensureRunning: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#runtime/k8s/egress/proxy-client', () => ({ proxyClient: { ensureRunning } }))

import { imageApp } from '#routes/images'
import { toErrorBody } from '#http'
import { retryImageBuild } from '#runtime/k8s/images/image-prewarm'
import {
  clearAllImageBuildsForTests,
  failImageBuild,
  ingestImageBuildLine,
  registerImageBuild,
} from '#runtime/k8s/image-engine/image-builds'
import type { ImageBuildEntry } from '@yaac/shared/types'

const mockRetry = vi.mocked(retryImageBuild)

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
  beforeEach(() => {
    clearAllImageBuildsForTests()
    mockRetry.mockReset()
    ensureRunning.mockClear()
  })
  afterEach(() => {
    clearAllImageBuildsForTests()
  })

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

  it('POST /builds/:id/retry relays the retry and returns 202', async () => {
    mockRetry.mockReturnValue({ retried: true, infra: false })
    const res = await app.request('/builds/build-1/retry', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(mockRetry).toHaveBeenCalledWith('build-1')
    // A project build rebuilds through its own chain — no proxy kick.
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  // An infra build has no owning project to rebuild through, so the route
  // drives the sidecar rebuild itself — detached, since the caller gets its
  // 202 either way.
  it('POST /builds/:id/retry rebuilds the proxy sidecar for an infra build', async () => {
    mockRetry.mockReturnValue({ retried: true, infra: true })
    const res = await app.request('/builds/build-1/retry', { method: 'POST' })
    expect(res.status).toBe(202)
    await Promise.resolve()
    expect(ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('POST /builds/:id/retry 404s when there is nothing to retry', async () => {
    mockRetry.mockReturnValue({ retried: false, infra: false })
    const res = await app.request('/builds/nope/retry', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(ensureRunning).not.toHaveBeenCalled()
  })
})
