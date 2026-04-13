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

  it('inserts erase-to-EOL before newlines to clear stale characters', async () => {
    const { sessionList } = await import('@/commands/session-list')
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') written.push(chunk)
      return true
    })

    let iterations = 0
    vi.mocked(sessionList).mockImplementation(() => {
      iterations++
      if (iterations >= 2) throw new Error('stop')
      // Simulate sessionList writing a line via console.log
      console.log('session line')
      return Promise.resolve()
    })

    // Suppress console.log output from appearing on real stdout
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      // console.log writes to process.stdout.write which is already spied
      const msg = args.map(String).join(' ') + '\n'
      process.stdout.write(msg)
    })

    await expect(sessionMonitor(undefined, { interval: '1' })).rejects.toThrow('stop')

    // Every newline written during rendering should be preceded by \x1B[K (erase to EOL)
    const renderWrites = written.filter((s) => s.includes('\n'))
    for (const w of renderWrites) {
      const newlines = [...w.matchAll(/\n/g)]
      for (const m of newlines) {
        const idx = m.index
        // Check that \x1B[K appears just before this newline
        expect(w.slice(idx - 3, idx)).toBe('\x1B[K')
      }
    }

    // \x1B[J should appear after each completed render cycle
    expect(written).toContain('\x1B[J')
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
