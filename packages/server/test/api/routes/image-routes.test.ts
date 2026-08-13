import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'

// These routes are pure translation: HTTP in, one mediator call out, and a
// 404 for an id it does not know. What a build IS, and what retrying one
// means, is the runtime's — so the feed stands behind a fake here and the
// assertions are about status codes and what reached the seam.
import { imageApp } from '#routes/images'
import { toErrorBody } from '#http'
import type { ImageBuildEntry, YaacConfig } from '@yaac/shared/types'

// The log route throws NOT_FOUND; only the root app's onError serializes it,
// so exercise the routes through a wrapper that installs the same handler.
const app = new Hono()
  .onError((err, c) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })
  .route('/', imageApp)

function buildEntry(overrides: Partial<ImageBuildEntry> = {}): ImageBuildEntry {
  return {
    id: 'b1',
    tag: 'yaac-base:abc',
    layer: 'base',
    action: 'build',
    projectSlugs: ['p'],
    reason: 'session',
    status: 'running',
    startedAt: '2026-01-01 00:00:00',
    ...overrides,
  }
}

const mockDismiss = vi.fn<(id: string) => boolean>()
const mockRetry = vi.fn<
  (id: string, cfg: (slug: string) => Promise<YaacConfig | undefined>) => boolean
>()

describe('image routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDismiss.mockReturnValue(true)
    mockRetry.mockReturnValue(true)
    installFakeWorktreeDriver({
      listImageBuilds: () => [buildEntry()],
      imageBuildLog: (id) => (id === 'b1' ? 'STEP 1/2: FROM ubuntu\n' : undefined),
      dismissImageBuild: mockDismiss,
      retryImageBuild: mockRetry,
    })
  })

  it('GET /builds lists what the runtime reports', async () => {
    const res = await app.request('/builds')
    expect(res.status).toBe(200)
    const body = await res.json() as ImageBuildEntry[]
    expect(body.map((b) => b.id)).toEqual(['b1'])
  })

  it('GET /builds/:id/log returns the accumulated tail', async () => {
    const res = await app.request('/builds/b1/log')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ log: 'STEP 1/2: FROM ubuntu\n' })
  })

  it('GET /builds/:id/log 404s for an unknown id', async () => {
    const res = await app.request('/builds/nope/log')
    expect(res.status).toBe(404)
  })

  // Dismissal is advisory: the route reports 204 either way rather than
  // making the webapp handle a row that stopped existing between the render
  // and the click.
  it('DELETE /builds/:id dismisses through the mediator', async () => {
    const res = await app.request('/builds/b1', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(mockDismiss).toHaveBeenCalledExactlyOnceWith('b1')
  })

  it('DELETE /builds/:id still answers 204 when there was nothing to dismiss', async () => {
    mockDismiss.mockReturnValue(false)
    const res = await app.request('/builds/nope', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })

  it('POST /builds/:id/retry relays the retry and returns 202', async () => {
    const res = await app.request('/builds/b1/retry', { method: 'POST' })
    expect(res.status).toBe(202)
    // The config reader the mediator injects — what the runtime rebuilds
    // with — travels with the id.
    expect(mockRetry).toHaveBeenCalledWith('b1', expect.any(Function))
  })

  it('POST /builds/:id/retry 404s when there is nothing to retry', async () => {
    mockRetry.mockReturnValue(false)
    const res = await app.request('/builds/nope/retry', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
