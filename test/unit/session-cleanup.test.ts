import { describe, it, expect } from 'vitest'
import { isTmuxSessionAlive, cleanupSession, cleanupSessionDetached } from '@/lib/session/cleanup'

describe('isTmuxSessionAlive', () => {
  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
  })
})

describe('cleanupSession', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSession).toBe('function')
  })
})

describe('cleanupSessionDetached', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSessionDetached).toBe('function')
  })
})
