import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { imageApp } from '@yaac/server/routes/image'
import {
  clearAllImageBuildsForTests,
  failImageBuild,
  ingestImageBuildLine,
  registerImageBuild,
} from '@yaac/server/image-builds'
import type { ImageBuildEntry } from '@yaac/shared/types'

function register(): string {
  return registerImageBuild({
    tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'p', reason: 'session',
  })
}

describe('image routes', () => {
  beforeEach(() => { clearAllImageBuildsForTests() })
  afterEach(() => { clearAllImageBuildsForTests() })

  it('GET /builds lists registry entries', async () => {
    const id = register()
    const res = await imageApp.request('/builds')
    expect(res.status).toBe(200)
    const body = await res.json() as ImageBuildEntry[]
    expect(body.map((b) => b.id)).toEqual([id])
  })

  it('GET /builds/:id/log returns the accumulated tail', async () => {
    const id = register()
    ingestImageBuildLine(id, 'STEP 1/2: FROM ubuntu')
    const res = await imageApp.request(`/builds/${id}/log`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ log: 'STEP 1/2: FROM ubuntu\n' })
  })

  it('GET /builds/:id/log 404s for an unknown id', async () => {
    const res = await imageApp.request('/builds/nope/log')
    expect(res.status).toBe(404)
  })

  it('DELETE /builds/:id dismisses a finished entry', async () => {
    const id = register()
    failImageBuild(id, 'boom')
    const res = await imageApp.request(`/builds/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const list = await (await imageApp.request('/builds')).json() as ImageBuildEntry[]
    expect(list).toEqual([])
  })

  it('DELETE /builds/:id leaves a running entry in place', async () => {
    const id = register()
    const res = await imageApp.request(`/builds/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const list = await (await imageApp.request('/builds')).json() as ImageBuildEntry[]
    expect(list.map((b) => b.id)).toEqual([id])
  })
})
