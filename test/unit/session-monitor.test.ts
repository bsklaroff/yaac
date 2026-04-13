import { describe, it, expect, vi, afterEach } from 'vitest'
import { sessionMonitor } from '@/commands/session-monitor'

vi.mock('@/commands/session-list', () => ({
  sessionList: vi.fn().mockResolvedValue(undefined),
}))

describe('sessionMonitor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clears screen and calls sessionList on each tick', async () => {
    const { sessionList } = await import('@/commands/session-list')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Abort after first iteration via a setTimeout rejection
    let iterations = 0
    vi.mocked(sessionList).mockImplementation(() => {
      iterations++
      if (iterations >= 2) throw new Error('stop')
      return Promise.resolve()
    })

    await expect(sessionMonitor(undefined, { interval: '1' })).rejects.toThrow('stop')

    expect(writeSpy).toHaveBeenCalledWith('\x1B[2J')
    expect(writeSpy).toHaveBeenCalledWith('\x1B[H')
    expect(writeSpy).toHaveBeenCalledWith('\x1B[J')
    expect(sessionList).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('yaac session monitor'))
  })

  it('passes project filter to sessionList', async () => {
    const { sessionList } = await import('@/commands/session-list')

    let iterations = 0
    vi.mocked(sessionList).mockImplementation(() => {
      iterations++
      if (iterations >= 1) throw new Error('stop')
      return Promise.resolve()
    })

    await expect(sessionMonitor('my-proj', { interval: '1' })).rejects.toThrow('stop')
    expect(sessionList).toHaveBeenCalledWith('my-proj')
  })
})
