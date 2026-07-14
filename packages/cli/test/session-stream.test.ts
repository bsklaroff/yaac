import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionStream } from '#commands/session-stream'
import { attachSessionPty } from '#commands/ws-terminal'
import { ServerError } from '@yaac/shared/errors'

// sessionStream reads the /session/stream/next JSON route via the `api`
// singleton, which resolves to the already-unwrapped body.
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#commands/api', () => ({
  api: { session: { stream: { next: { $post: post } } } },
}))

vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

type StreamResponse =
  | { done: true; reason: 'no_active' | 'closed_blank' | 'needs_project'; candidates?: string[] }
  | {
      done: false
      sessionId: string
      jobName: string
      projectSlug: string
      tool: 'claude' | 'codex'
      visited: string[]
      lastVisited: string
    }

function mockStream(responses: StreamResponse[]): void {
  post.mockReset()
  for (const r of responses) {
    post.mockResolvedValueOnce(r)
  }
}

describe('sessionStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    post.mockReset()
  })

  it('exits when the server reports done:no_active', async () => {
    mockStream([{ done: true, reason: 'no_active' }])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sessionStream()

    expect(post).toHaveBeenCalledTimes(1)
    expect(attachSessionPty).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('No projects found. Add one with: yaac project add <remote-url>')
  })

  it('exits when the server reports done:closed_blank', async () => {
    mockStream([{ done: true, reason: 'closed_blank' }])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sessionStream('demo')

    expect(attachSessionPty).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('Closed blank session and found no waiting sessions. Exiting session stream.')
  })

  it('auto-selects a single candidate from needs_project and retries', async () => {
    mockStream([
      { done: true, reason: 'needs_project', candidates: ['only-one'] },
      { done: true, reason: 'no_active' },
    ])

    await sessionStream()

    expect(post).toHaveBeenCalledTimes(2)
    expect((post.mock.calls[1][0] as { json: { project: string } }).json.project).toBe('only-one')
  })

  it('attaches sessions returned by the server until it reports done', async () => {
    mockStream([
      {
        done: false,
        sessionId: 'abc',
        jobName: 'yaac-demo-abc',
        projectSlug: 'demo',
        tool: 'claude',
        visited: ['abc'],
        lastVisited: 'abc',
      },
      { done: true, reason: 'closed_blank' },
    ])

    await sessionStream('demo')

    expect(attachSessionPty).toHaveBeenCalledTimes(1)
    expect(attachSessionPty).toHaveBeenCalledWith('abc', 'native')
    expect(post).toHaveBeenCalledTimes(2)
    const secondCall = post.mock.calls[1][0] as { json: unknown }
    expect(secondCall.json).toMatchObject({
      visited: ['abc'],
      lastVisited: 'abc',
      lastProjectSlug: 'demo',
      lastTool: 'claude',
      lastOutcome: 'detached',
    })
  })

  it('propagates server errors', async () => {
    // The throwing API client rejects on a non-2xx response.
    post.mockReset()
    post.mockRejectedValue(new ServerError('INTERNAL', 'boom'))

    await expect(sessionStream()).rejects.toThrow('boom')
  })
})
