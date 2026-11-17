import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverLog } from '#lib/log'
import { HOLD_CAP_MS, ofCheckout, startTiming, timingOf } from '#lib/start-timing'

const logged = (): string[] => vi.mocked(serverLog).mock.calls.map(([line]) => line)

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
  vi.mocked(serverLog).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startTiming', () => {
  it('writes one line of phases, ordered by start, with facts after them', async () => {
    const t = startTiming('create', 'ws-1')
    let landed!: () => void
    const fetch = new Promise<void>((r) => { landed = r })
    void t.time('fetch', fetch)
    vi.advanceTimersByTime(40)
    t.phase('checks', 1_000_000)
    // A failed task is timed as well, and handed back as it was.
    const launch = t.time('launch', Promise.reject(new Error('no')))
    await expect(launch).rejects.toThrow('no')
    vi.advanceTimersByTime(60)
    landed()
    await fetch
    // In-pod clocks report spans of their own.
    t.phase('tree fill', 1_000_010, 1_000_030)
    t.phase('checks', 0, 1)
    t.note('catchup', 'ff')
    t.note('catchup', 'reset')
    expect(logged()).toEqual([])
    t.end('ok')
    expect(logged()).toEqual([
      '[timing] ws-1 create ok total=100 checks=0+40 fetch=0+100 tree_fill=10+20 launch=40+0 catchup=ff',
    ])
    expect(timingOf('ws-1')).toBeUndefined()
  })

  it('waits for what it holds, and for an agent seen before or after it was expected', () => {
    const t = startTiming('claim')
    t.phase('probe', 1_000_000, 1_000_005)
    vi.advanceTimersByTime(10)
    t.identify('spare-1')
    expect(timingOf('spare-1')).toBe(t)
    const release = t.hold()
    t.expect('claude-1', 'agent.claude', Date.now())
    timingOf('spare-1')?.seen('pi-1')
    vi.advanceTimersByTime(5)
    t.expect('pi-1', 'agent.pi', 1_000_000)
    t.end('ok')
    vi.advanceTimersByTime(20)
    timingOf('spare-1')?.seen('claude-1')
    expect(logged()).toEqual([])
    release()
    release()
    expect(logged()).toEqual(['[timing] spare-1 claim ok total=15 probe=0+5 agent.pi=0+10 agent.claude=10+25'])
    // Nothing after the line changes it.
    t.note('late', 'x')
    t.end('failed')
    expect(logged()).toHaveLength(1)
  })

  it('writes what it has once a hold outlasts the cap', () => {
    const t = startTiming('warm', 'spare-2')
    t.expect('claude-1', 'agent.claude', Date.now())
    t.end('failed')
    vi.advanceTimersByTime(HOLD_CAP_MS - 1)
    expect(logged()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(logged()).toEqual(['[timing] spare-2 warm failed total=0'])
  })

  it('writes nothing for a start that never named its workspace', () => {
    const t = startTiming('claim')
    t.phase('list', 1_000_000)
    t.end('fallback')
    vi.advanceTimersByTime(HOLD_CAP_MS)
    expect(logged()).toEqual([])
  })
})

describe('timingOf', () => {
  it('finds only an open start, by the id it was last given', () => {
    expect(timingOf('none')).toBeUndefined()
    const t = startTiming('claim', 'first')
    t.identify('second')
    expect(timingOf('first')).toBeUndefined()
    expect(timingOf('second')).toBe(t)
    // A newer start of the same workspace replaces it, and the older one's
    // line does not take the newer one with it.
    const next = startTiming('restart', 'second')
    t.end('ok')
    expect(timingOf('second')).toBe(next)
    next.end('ok')
    expect(timingOf('second')).toBeUndefined()
  })
})

describe('ofCheckout', () => {
  it('names a root checkout plainly and one in a folder by it', () => {
    expect(ofCheckout('fetch', '')).toBe('fetch')
    expect(ofCheckout('fetch', 'api')).toBe('fetch.api')
  })
})
