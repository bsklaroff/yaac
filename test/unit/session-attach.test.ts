import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionAttach } from '@/commands/session-attach'
import { getRpcClient } from '@/shared/daemon-client'
import type * as daemonClientModule from '@/shared/daemon-client'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('@/shared/daemon-client', async (importOriginal) => {
  const actual = await importOriginal<typeof daemonClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockImplementation(async (res: Response) => {
      const body = await res.json() as { error?: { message?: string } }
      return new Error(body.error?.message ?? `daemon ${res.status}`)
    }),
  }
})

function mockAttachedChild(): EventEmitter {
  const child = new EventEmitter()
  process.nextTick(() => child.emit('close', 0))
  return child
}

describe('sessionAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('fetches attach-info and spawns podman exec tmux attach', async () => {
    vi.mocked(spawn).mockImplementation(() => mockAttachedChild() as never)
    const mockGet = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ containerName: 'yaac-demo-abc', tmuxSession: 'yaac' }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { ':id': { 'attach-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await sessionAttach('abc')

    expect(mockGet).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(spawn).toHaveBeenCalledWith(
      'podman',
      ['exec', '-it', 'yaac-demo-abc', 'tmux', 'attach-session', '-t', 'yaac'],
      { stdio: 'inherit' },
    )
  })

  it('throws when the daemon returns a non-ok response', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { code: 'NOT_FOUND', message: 'session bogus not found' } }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { ':id': { 'attach-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await expect(sessionAttach('bogus')).rejects.toThrow('session bogus not found')
    expect(spawn).not.toHaveBeenCalled()
  })
})
