import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  _resetHerdEventsForTests,
  emitHerdEvent,
  onHerdEvent,
} from '#herd-events'
import { serverLog } from '#log'
import type { HerdEvent } from '@yaac/shared/herd'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

afterEach(() => {
  _resetHerdEventsForTests()
  vi.mocked(serverLog).mockClear()
})

const stopped: HerdEvent = {
  type: 'worktree-stopped',
  projectSlug: 'proj',
  worktreeId: 'wt-1',
}

describe('herd event channel', () => {
  it('delivers each event to the registered sink', async () => {
    const seen: HerdEvent[] = []
    onHerdEvent((e) => {
      seen.push(e)
      return Promise.resolve()
    })

    await emitHerdEvent(stopped)
    await emitHerdEvent({ ...stopped, worktreeId: 'wt-2' })

    expect(seen.map((e) => e.worktreeId)).toEqual(['wt-1', 'wt-2'])
  })

  // The emit is what a caller tearing a session down awaits: a listing
  // between the emit and the write would show the worktree as neither
  // running nor stopped.
  it('resolves only once the sink has applied the event', async () => {
    let applied = false
    let release = (): void => {}
    onHerdEvent(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      applied = true
    })

    const emitted = emitHerdEvent(stopped)
    let settled = false
    void emitted.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await emitted
    expect(applied).toBe(true)
  })

  it('propagates a sink failure to the emitter', async () => {
    onHerdEvent(() => Promise.reject(new Error('db is gone')))
    await expect(emitHerdEvent(stopped)).rejects.toThrow('db is gone')
  })

  it('last registration wins', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    onHerdEvent(first)
    onHerdEvent(second)

    await emitHerdEvent(stopped)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(stopped)
  })

  // A drop is normal in a unit test that is not exercising persistence, and
  // a bug anywhere else — so it must not pass silently.
  it('logs rather than throws when nothing is registered', async () => {
    await expect(emitHerdEvent(stopped)).resolves.toBeUndefined()
    expect(vi.mocked(serverLog).mock.calls[0]?.[0]).toContain('worktree-stopped')
  })
})
