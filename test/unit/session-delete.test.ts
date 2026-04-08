import { describe, it, expect } from 'vitest'
import { sessionDelete } from '@/commands/session-delete'

describe('sessionDelete', () => {
  it('is exported as a function', () => {
    expect(typeof sessionDelete).toBe('function')
  })
})
