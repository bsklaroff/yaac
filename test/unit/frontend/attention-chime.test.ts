import { describe, it, expect } from 'vitest'
import { waitingKey, waitingSpellKeys, newlyWaitingSessions, shouldChime } from '@/frontend/lib/attentionChime'
import type { SessionListEntry } from '@/shared/types'

type W = Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>
const s = (sessionId: string, status: W['status'], waitingSinceMs?: number): W => ({ sessionId, status, waitingSinceMs })

describe('waitingKey', () => {
  it('combines id and spell start (0 when missing)', () => {
    expect(waitingKey(s('a', 'waiting', 100))).toBe('a:100')
    expect(waitingKey(s('a', 'waiting'))).toBe('a:0')
  })
})

describe('waitingSpellKeys', () => {
  it('keys only waiting sessions', () => {
    expect([...waitingSpellKeys([s('a', 'waiting', 100), s('b', 'running', 0)])]).toEqual(['a:100'])
  })
})

describe('newlyWaitingSessions', () => {
  it('returns waiting sessions whose spell key is new', () => {
    const fresh = newlyWaitingSessions(new Set(['a:100']), [s('a', 'waiting', 100), s('b', 'waiting', 50)])
    expect(fresh.map((x) => x.sessionId)).toEqual(['b'])
  })

  it('counts a re-waiting session (new spell start) as new', () => {
    const fresh = newlyWaitingSessions(new Set(['a:100']), [s('a', 'waiting', 250)])
    expect(fresh.map((x) => x.sessionId)).toEqual(['a'])
  })
})

describe('shouldChime', () => {
  it('chimes when a newly-waiting session is not the one being watched', () => {
    expect(shouldChime([s('a', 'waiting', 1), s('b', 'waiting', 1)], 'a')).toBe(true)
  })

  it('does not chime when the only newly-waiting session is being watched', () => {
    expect(shouldChime([s('a', 'waiting', 1)], 'a')).toBe(false)
  })

  it('chimes for any newly-waiting session when watching nothing (away/unfocused)', () => {
    expect(shouldChime([s('a', 'waiting', 1)], null)).toBe(true)
  })

  it('is false with no newly-waiting sessions', () => {
    expect(shouldChime([], 'a')).toBe(false)
  })
})
