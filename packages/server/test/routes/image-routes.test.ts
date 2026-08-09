import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

// Image builds are the herd's, so these routes are pure translation: HTTP in,
// one herd call out, and a 404 for an id it does not know. The real registry
// stands behind the stub for the read routes (so a case asserts on entries it
// registered), and the retry outcome is dictated — what a retry actually does
// is asserted in test/herd/in-process.test.ts.
import { imageApp } from '#routes/images'
import { toErrorBody } from '#http'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import {
  clearAllImageBuildsForTests,
  dismissImageBuild,
  failImageBuild,
  getImageBuildLog,
  ingestImageBuildLine,
  listImageBuilds,
  registerImageBuild,
} from '#features/image-engine/image-builds'
import type { ImageBuildEntry } from '@yaac/shared/types'

const retryImageBuild = vi.fn<(id: string) => Promise<{ retried: boolean; infra: boolean }>>()

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
    vi.clearAllMocks()
    _setHerdForTests({
      images: {
        listBuilds: () => Promise.resolve(listImageBuilds()),
        buildLog: (id) => Promise.resolve(getImageBuildLog(id)),
        dismissBuild: (id) => { dismissImageBuild(id); return Promise.resolve() },
        retryBuild: retryImageBuild,
      },
    })
  })
  afterEach(() => {
    _resetHerdForTests()
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

  // 202 either way — whether the rebuild is a project chain or the proxy
  // sidecar is the herd's business, and the route never learns which.
  it('POST /builds/:id/retry asks the herd and returns 202', async () => {
    for (const infra of [false, true]) {
      retryImageBuild.mockResolvedValue({ retried: true, infra })
      const res = await app.request('/builds/build-1/retry', { method: 'POST' })
      expect(res.status).toBe(202)
      expect(retryImageBuild).toHaveBeenCalledWith('build-1')
    }
  })

  it('POST /builds/:id/retry 404s when there is nothing to retry', async () => {
    retryImageBuild.mockResolvedValue({ retried: false, infra: false })
    const res = await app.request('/builds/nope/retry', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
