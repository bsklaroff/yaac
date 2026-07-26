import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LISTENER_RANGE,
  type ListenerRange,
  slotPreference,
  trioForSlot,
  trioPorts,
} from 'yaac-netd/ports'

const RANGE: ListenerRange = DEFAULT_LISTENER_RANGE

describe('trioForSlot', () => {
  it('lays trios out contiguously from the range base', () => {
    expect(trioForSlot(0)).toEqual({
      https: RANGE.base, http: RANGE.base + 1, tunnel: RANGE.base + 2,
    })
    expect(trioForSlot(1).https).toBe(RANGE.base + 3)
  })

  it('honours a range passed in from the env', () => {
    expect(trioForSlot(2, { base: 20000, slots: 10 })).toEqual({
      https: 20006, http: 20007, tunnel: 20008,
    })
  })
})

describe('trioPorts', () => {
  it('lists the trio in leg order', () => {
    expect(trioPorts({ https: 1, http: 2, tunnel: 3 })).toEqual([1, 2, 3])
  })
})

describe('slotPreference', () => {
  it('covers every slot exactly once, so a probe can never run out early', () => {
    const order = slotPreference('yaac', { base: 15100, slots: 8 })
    expect(order).toHaveLength(8)
    expect(new Set(order).size).toBe(8)
  })

  it('is deterministic — a restarted netd probes in the same order', () => {
    expect(slotPreference('yaac')).toEqual(slotPreference('yaac'))
  })

  it('gives coexisting installs different first choices', () => {
    // The real install and an e2e run's share a node's netns; landing on
    // the same first slot would make one of them re-probe every time.
    expect(slotPreference('yaac')[0]).not.toBe(slotPreference('yaac-test-abc')[0])
  })

  it('probes forward with wrap from the hashed slot', () => {
    const range = { base: 15100, slots: 5 }
    const order = slotPreference('yaac', range)
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBe((order[0] + i) % range.slots)
    }
  })

  it('keeps every port inside the reserved range', () => {
    for (const slot of slotPreference('yaac')) {
      const trio = trioForSlot(slot)
      expect(trio.https).toBeGreaterThanOrEqual(RANGE.base)
      expect(trio.tunnel).toBeLessThan(RANGE.base + RANGE.slots * 3)
    }
  })
})
