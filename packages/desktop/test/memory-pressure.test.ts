import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The macOS pressure level, as `sysctl -n` prints it.
const sysctl = vi.hoisted(() => ({ level: '1' }))
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], cb: (err: null, out: { stdout: string }) => void) => {
    cb(null, { stdout: `${sysctl.level}\n` })
  },
}))

import { underCriticalPressure, watchMemoryPressure } from '#memory-pressure'

const platform = process.platform
const MIB = 1024
let memory: { free: number; available?: number }

/** Run as `os`, where Electron's system memory reads `memory`. */
function onPlatform(os: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: os })
}

beforeEach(() => {
  memory = { free: 8000 * MIB, available: 8000 * MIB }
  Object.assign(process, { getSystemMemoryInfo: () => memory })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.useRealTimers()
})

describe('underCriticalPressure', () => {
  it('follows macOS\'s own level there, and available memory under 400 MiB elsewhere', async () => {
    onPlatform('darwin')
    memory = { free: 10 * MIB }
    expect(await underCriticalPressure()).toBe(false)
    sysctl.level = '2'
    expect(await underCriticalPressure()).toBe(false)
    sysctl.level = '4'
    expect(await underCriticalPressure()).toBe(true)

    // Linux counts reclaimable cache as available, which `free` leaves out.
    onPlatform('linux')
    memory = { free: 100 * MIB, available: 2000 * MIB }
    expect(await underCriticalPressure()).toBe(false)
    memory = { free: 100 * MIB, available: 399 * MIB }
    expect(await underCriticalPressure()).toBe(true)

    onPlatform('win32')
    memory = { free: 401 * MIB }
    expect(await underCriticalPressure()).toBe(false)
    memory = { free: 399 * MIB }
    expect(await underCriticalPressure()).toBe(true)
  })
})

/** A page that counts the pressure signals it is sent. */
function fakePage() {
  const page = Object.assign(new EventEmitter(), { signals: 0, isDestroyed: () => false, send: () => { page.signals++ } })
  return page
}

describe('watchMemoryPressure', () => {
  it('signals the page on every five-second check that finds critical pressure, until stopped', async () => {
    vi.useFakeTimers()
    onPlatform('linux')
    const page = fakePage()
    const stop = watchMemoryPressure(page)

    await vi.advanceTimersByTimeAsync(5000)
    expect(page.signals).toBe(0)
    memory = { free: 0, available: 100 * MIB }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(page.signals).toBe(2)

    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(page.signals).toBe(2)
    expect(page.eventNames()).toEqual([])
  })

  it('ends with the document that asked: a navigation, a renderer crash, or teardown', async () => {
    vi.useFakeTimers()
    onPlatform('linux')
    memory = { free: 0, available: 100 * MIB }
    for (const end of ['did-navigate', 'render-process-gone', 'destroyed']) {
      const page = fakePage()
      watchMemoryPressure(page)
      await vi.advanceTimersByTimeAsync(5000)
      page.emit(end)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(page.signals, end).toBe(1)
      expect(page.eventNames(), end).toEqual([])
    }
  })
})
