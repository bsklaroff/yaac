import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionShell } from '@/commands/session-shell'
import { getRpcClient } from '@/shared/daemon-client'
import type * as daemonClientModule from '@/shared/daemon-client'

// `@/lib/k8s/kubectl` (pulled in via `@/lib/k8s/exec`) promisifies
// execFile/exec at module load, so the child_process mock must provide
// them even though this test only asserts on spawn.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
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

describe('sessionShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('fetches attach-info and spawns kubectl exec zsh', async () => {
    vi.mocked(spawn).mockImplementation(() => mockAttachedChild() as never)
    const mockGet = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobName: 'yaac-demo-abc' }),
    })
    vi.mocked(getRpcClient).mockResolvedValue({
      session: { ':id': { 'attach-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await sessionShell('abc')

    expect(mockGet).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(spawn).toHaveBeenCalledWith(
      'kubectl',
      ['exec', '-n', 'yaac', '-it', 'job/yaac-demo-abc', '--', 'zsh'],
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
      session: { ':id': { 'attach-info': { $get: mockGet } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)

    await expect(sessionShell('dead')).rejects.toThrow('not running')
    expect(spawn).not.toHaveBeenCalled()
  })
})
