import { describe, it, expect } from 'vitest'
import { resolveStoppedLimit, STOPPED_DEFAULT_LIMIT, worktreeList } from '#commands/worktree-list'

describe('resolveStoppedLimit', () => {
  it('returns the default limit when no options are supplied', () => {
    expect(resolveStoppedLimit({})).toBe(STOPPED_DEFAULT_LIMIT)
  })

  it('returns undefined when --all is set', () => {
    expect(resolveStoppedLimit({ all: true })).toBeUndefined()
  })

  it('lets --all override --num', () => {
    expect(resolveStoppedLimit({ all: true, num: 5 })).toBeUndefined()
  })

  it('honours a positive --num', () => {
    expect(resolveStoppedLimit({ num: 7 })).toBe(7)
  })

  it('floors a fractional --num', () => {
    expect(resolveStoppedLimit({ num: 7.9 })).toBe(7)
  })

  it('falls back to the default when --num is zero, negative, or NaN', () => {
    expect(resolveStoppedLimit({ num: 0 })).toBe(STOPPED_DEFAULT_LIMIT)
    expect(resolveStoppedLimit({ num: -5 })).toBe(STOPPED_DEFAULT_LIMIT)
    expect(resolveStoppedLimit({ num: Number.NaN })).toBe(STOPPED_DEFAULT_LIMIT)
  })
})

describe('worktreeList', () => {
  it('is exported as a function', () => {
    expect(typeof worktreeList).toBe('function')
  })
})
