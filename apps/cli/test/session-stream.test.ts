import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionStream } from '#commands/session-stream'
import { attachSessionPty } from '#commands/ws-terminal'
import { getRpcClient } from '@yaac/shared/server-client'
import type * as serverClientModule from '@yaac/shared/server-client'

vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/shared/server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof serverClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockImplementation(async (res: Response) => {
      const body = await res.json() as { error?: { message?: string } }
      return new Error(body.error?.message ?? `server ${res.status}`)
    }),
  }
})

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

function mockStream(responses: StreamResponse[]): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn()
  for (const r of responses) {
    post.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(r) })
  }
  vi.mocked(getRpcClient).mockResolvedValue({
    session: { stream: { next: { $post: post } } },
  } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
  return { post }
}

describe('sessionStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exits when the server reports done:no_active', async () => {
    const { post } = mockStream([{ done: true, reason: 'no_active' }])
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
    const { post } = mockStream([
      { done: true, reason: 'needs_project', candidates: ['only-one'] },
      { done: true, reason: 'no_active' },
    ])

    await sessionStream()

    expect(post).toHaveBeenCalledTimes(2)
    expect((post.mock.calls[1][0] as { json: { project: string } }).json.project).toBe('only-one')
  })

  it('attaches sessions returned by the server until it reports done', async () => {
    const { post } = mockStream([
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
    const post = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: 'INTERNAL', message: 'boom' } }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { stream: { next: { $post: post } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await expect(sessionStream()).rejects.toThrow('boom')
  })
})
