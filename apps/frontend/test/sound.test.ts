// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { playChime } from '#lib/sound'

describe('playChime', () => {
  it('is a safe no-op when Web Audio is unavailable', () => {
    // jsdom implements no AudioContext, so the shared context resolves to null
    // and playChime returns without throwing.
    expect((window as unknown as { AudioContext?: unknown }).AudioContext).toBeUndefined()
    expect(() => playChime()).not.toThrow()
  })
})
