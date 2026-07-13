import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#commands/rpc', () => ({
  getRpcClient: vi.fn(),
}))

import { getRpcClient } from '#commands/rpc'
import { projectRebuild } from '#commands/project-rebuild'
import { ServerError } from '@yaac/shared/errors'

function ndjsonResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  return new Response(body, { status })
}

function mockClient(post: () => Response): void {
  vi.mocked(getRpcClient).mockResolvedValue({
    project: { ':slug': { rebuild: { $post: vi.fn(post) } } },
  } as never)
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
    mockClient(() => ndjsonResponse([
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
    mockClient(() => ndjsonResponse([
      { type: 'error', error: { code: 'NOT_FOUND', message: 'project "nope" not found' } },
    ]))

    await expect(projectRebuild('nope')).rejects.toThrow('project "nope" not found')
  })

  it('throws when the stream ends without a result', async () => {
    mockClient(() => ndjsonResponse([
      { type: 'progress', message: 'building...' },
    ]))

    await expect(projectRebuild('myproject')).rejects.toThrow(/without a result/)
  })

  it('propagates a server error thrown by the client on a non-2xx response', async () => {
    // The throwing RPC client rejects before any stream is read.
    vi.mocked(getRpcClient).mockResolvedValue({
      project: {
        ':slug': {
          rebuild: { $post: vi.fn().mockRejectedValue(new ServerError('INTERNAL', 'server returned 500')) },
        },
      },
    } as never)

    await expect(projectRebuild('myproject')).rejects.toThrow('server returned 500')
  })
})
