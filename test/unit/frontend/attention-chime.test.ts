import { describe, it, expect } from 'vitest'
import { waitingSpellKeys, newlyWaiting } from '@/frontend/lib/attentionChime'
import type { SessionListEntry } from '@/shared/types'

type W = Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>
const s = (sessionId: string, status: W['status'], waitingSinceMs?: number): W => ({ sessionId, status, waitingSinceMs })

describe('waitingSpellKeys', () => {
  it('keys only waiting sessions by id + spell start', () => {
    const keys = waitingSpellKeys([s('a', 'waiting', 100), s('b', 'running', 0), s('c', 'waiting', 200)])
    expect([...keys].sort()).toEqual(['a:100', 'c:200'])
  })

  it('treats a missing waitingSinceMs as 0', () => {
    expect([...waitingSpellKeys([s('a', 'waiting')])]).toEqual(['a:0'])
  })
})

describe('newlyWaiting', () => {
  it('returns keys present now but not before', () => {
    expect(newlyWaiting(new Set(['a:100']), new Set(['a:100', 'b:50']))).toEqual(['b:50'])
  })

  it('counts a fresh waiting spell (new waitingSinceMs) as new', () => {
    expect(newlyWaiting(new Set(['a:100']), new Set(['a:250']))).toEqual(['a:250'])
  })

  it('is empty when the waiting set is unchanged', () => {
    expect(newlyWaiting(new Set(['a:1']), new Set(['a:1']))).toEqual([])
  })
})
