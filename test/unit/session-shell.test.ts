import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionShell } from '@/commands/session-shell'
import { getRpcClient } from '@/lib/daemon-client'
import type * as daemonClientModule from '@/lib/daemon-client'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('@/lib/daemon-client', async (importOriginal) => {
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

describe('sessionShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('fetches shell-info and spawns podman exec zsh', async () => {
    vi.mocked(spawn).mockImplementation(() => mockAttachedChild() as never)
    const mockGet = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ containerName: 'yaac-demo-abc' }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { ':id': { 'shell-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await sessionShell('abc')

    expect(mockGet).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(spawn).toHaveBeenCalledWith(
      'podman',
      ['exec', '-it', 'yaac-demo-abc', 'zsh'],
      { stdio: 'inherit' },
    )
  })

  it('throws when the daemon returns a non-ok response', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: { code: 'CONFLICT', message: 'not running' } }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { ':id': { 'shell-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await expect(sessionShell('dead')).rejects.toThrow('not running')
    expect(spawn).not.toHaveBeenCalled()
  })
})
