import { describe, it, expect } from 'vitest'
import {
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  nextReconnectDelay,
} from '#lib/reconnect'

describe('nextReconnectDelay', () => {
  it('doubles the current delay below the cap', () => {
    expect(nextReconnectDelay(INITIAL_RECONNECT_DELAY_MS)).toBe(1000)
    expect(nextReconnectDelay(1000)).toBe(2000)
    expect(nextReconnectDelay(2000)).toBe(4000)
  })

  it('clamps to the ceiling and stays there', () => {
    expect(nextReconnectDelay(8000)).toBe(MAX_RECONNECT_DELAY_MS)
    expect(nextReconnectDelay(MAX_RECONNECT_DELAY_MS)).toBe(MAX_RECONNECT_DELAY_MS)
  })

  it('climbs from the initial delay to the cap by repeated application', () => {
    let delay = INITIAL_RECONNECT_DELAY_MS
    const seen = [delay]
    for (let i = 0; i < 10; i++) {
      delay = nextReconnectDelay(delay)
      seen.push(delay)
    }
    expect(seen.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, MAX_RECONNECT_DELAY_MS])
    expect(delay).toBe(MAX_RECONNECT_DELAY_MS)
  })
})
