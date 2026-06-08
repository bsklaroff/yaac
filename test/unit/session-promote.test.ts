import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/commands/rpc', () => ({
  getRpcClient: vi.fn(),
  toClientError: vi.fn(() => Promise.resolve(new Error('client error'))),
}))

import { getRpcClient } from '@/commands/rpc'
import { sessionPromote } from '@/commands/session-promote'

/**
 * Build a fake NDJSON `Response` (one JSON event per line) for the daemon's
 * `POST /session/promote` stream, so the command's stream consumer can be
 * exercised without a daemon.
 */
function ndjsonResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  return new Response(body, { status })
}

function mockClient(post: () => Response): void {
  vi.mocked(getRpcClient).mockResolvedValue({
    session: { promote: { $post: vi.fn(post) } },
  } as never)
}

describe('sessionPromote', () => {
  let printed: unknown[]
  let errors: unknown[]

  beforeEach(() => {
    printed = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a[0]) })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a[0]) })
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('prints streamed progress lines and leaves exit code unset on success', async () => {
    mockClient(() => ndjsonResponse([
      { type: 'progress', message: '[promoter] start' },
      { type: 'progress', message: '[promoter] COPY abc OK' },
      { type: 'result', result: { sessionId: 's1', projectSlug: 'p', imageRef: 'img:tag', exitCode: 0 } },
    ]))

    await sessionPromote('s1')

    expect(printed).toContain('[promoter] start')
    expect(printed).toContain('[promoter] COPY abc OK')
    expect(process.exitCode).toBeUndefined()
  })

  it('sets process.exitCode when the promoter exits non-zero', async () => {
    mockClient(() => ndjsonResponse([
      { type: 'progress', message: '[promoter] COPY abc FAILED' },
      { type: 'result', result: { sessionId: 's1', projectSlug: 'p', imageRef: 'img:tag', exitCode: 7 } },
    ]))

    await sessionPromote('s1')

    expect(process.exitCode).toBe(7)
    expect(errors).toContain('Promoter exited with code 7.')
  })

  it('throws the daemon message on an error event', async () => {
    mockClient(() => ndjsonResponse([
      { type: 'error', error: { code: 'NOT_FOUND', message: 'session "nope" not found' } },
    ]))

    await expect(sessionPromote('nope')).rejects.toThrow('session "nope" not found')
  })

  it('throws when the stream ends without a result', async () => {
    mockClient(() => ndjsonResponse([
      { type: 'progress', message: 'only progress, no result' },
    ]))

    await expect(sessionPromote('s1')).rejects.toThrow(/without a result/)
  })

  it('surfaces a non-ok HTTP response via toClientError', async () => {
    mockClient(() => ndjsonResponse([], 500))

    await expect(sessionPromote('s1')).rejects.toThrow('client error')
  })
})
