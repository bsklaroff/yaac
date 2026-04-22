import { describe, it, expect } from 'vitest'
import { resolveDeletedLimit, DELETED_DEFAULT_LIMIT, sessionList } from '@/commands/session-list'

describe('resolveDeletedLimit', () => {
  it('returns the default limit when no options are supplied', () => {
    expect(resolveDeletedLimit({})).toBe(DELETED_DEFAULT_LIMIT)
  })

  it('returns undefined when --all is set', () => {
    expect(resolveDeletedLimit({ all: true })).toBeUndefined()
  })

  it('lets --all override --num', () => {
    expect(resolveDeletedLimit({ all: true, num: 5 })).toBeUndefined()
  })

  it('honours a positive --num', () => {
    expect(resolveDeletedLimit({ num: 7 })).toBe(7)
  })

  it('floors a fractional --num', () => {
    expect(resolveDeletedLimit({ num: 7.9 })).toBe(7)
  })

  it('falls back to the default when --num is zero, negative, or NaN', () => {
    expect(resolveDeletedLimit({ num: 0 })).toBe(DELETED_DEFAULT_LIMIT)
    expect(resolveDeletedLimit({ num: -5 })).toBe(DELETED_DEFAULT_LIMIT)
    expect(resolveDeletedLimit({ num: Number.NaN })).toBe(DELETED_DEFAULT_LIMIT)
  })
})

describe('sessionList', () => {
  it('is exported as a function', () => {
    expect(typeof sessionList).toBe('function')
  })
})
