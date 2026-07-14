import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// projectRebuild uses the shared `api` singleton; mock it. The rebuild route
// is a stream, so its leaf resolves to a raw Response (the client only unwraps
// JSON routes), which `consumeNdjsonStream` reads.
const { rebuildPost } = vi.hoisted(() => ({ rebuildPost: vi.fn() }))
vi.mock('#commands/api', () => ({
  api: { project: { ':slug': { rebuild: { $post: rebuildPost } } } },
}))

import { projectRebuild } from '#commands/project-rebuild'
import { ServerError } from '@yaac/shared/errors'

function ndjsonResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  return new Response(body, { status })
}

describe('projectRebuild', () => {
  let printed: string[]

  beforeEach(() => {
    printed = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(String(a[0])) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints streamed progress and the final-tag summary on success', async () => {
    rebuildPost.mockResolvedValue(ndjsonResponse([
      { type: 'progress', message: 'removing existing image yaac-tools:abc' },
      { type: 'progress', message: 'building yaac-tools:abc (no cache)' },
      { type: 'result', result: { projectSlug: 'myproject', finalTag: 'yaac-tools:abc' } },
    ]))

    await projectRebuild('myproject')

    expect(printed).toContain('removing existing image yaac-tools:abc')
    expect(printed).toContain('building yaac-tools:abc (no cache)')
    expect(printed).toContain('Rebuilt myproject → yaac-tools:abc')
  })

  it('throws the server message on an error event', async () => {
    rebuildPost.mockResolvedValue(ndjsonResponse([
      { type: 'error', error: { code: 'NOT_FOUND', message: 'project "nope" not found' } },
    ]))

    await expect(projectRebuild('nope')).rejects.toThrow('project "nope" not found')
  })

  it('throws when the stream ends without a result', async () => {
    rebuildPost.mockResolvedValue(ndjsonResponse([
      { type: 'progress', message: 'building...' },
    ]))

    await expect(projectRebuild('myproject')).rejects.toThrow(/without a result/)
  })

  it('propagates a server error thrown by the client on a non-2xx response', async () => {
    // The throwing API client rejects before any stream is read.
    rebuildPost.mockRejectedValue(new ServerError('INTERNAL', 'server returned 500'))

    await expect(projectRebuild('myproject')).rejects.toThrow('server returned 500')
  })
})
