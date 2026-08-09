import { describe, it, expect } from 'vitest'
import { waitingKey, waitingSpellKeys, newlyWaitingWorktrees, shouldChime } from '#lib/attentionChime'
import type { WorktreeListEntry } from '@yaac/shared/types'

type W = Pick<WorktreeListEntry, 'worktreeId' | 'status' | 'waitingSinceMs'>
const s = (worktreeId: string, status: W['status'], waitingSinceMs?: number): W => ({ worktreeId, status, waitingSinceMs })

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

describe('newlyWaitingWorktrees', () => {
  it('returns waiting sessions whose spell key is new', () => {
    const fresh = newlyWaitingWorktrees(new Set(['a:100']), [s('a', 'waiting', 100), s('b', 'waiting', 50)])
    expect(fresh.map((x) => x.worktreeId)).toEqual(['b'])
  })

  it('counts a re-waiting session (new spell start) as new', () => {
    const fresh = newlyWaitingWorktrees(new Set(['a:100']), [s('a', 'waiting', 250)])
    expect(fresh.map((x) => x.worktreeId)).toEqual(['a'])
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
