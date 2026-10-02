import { describe, it, expect } from 'vitest'
import { newlyWaiting, waitingKeys } from '#waiting'
import type { WorkspaceListEntry } from '#types'

type W = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs'>
const w = (workspaceId: string, status: W['status'], waitingSinceMs?: number): W => ({ workspaceId, status, waitingSinceMs })

describe('waitingKeys', () => {
  it('keys each waiting workspace by its spell, 0 when the start is missing', () => {
    expect([...waitingKeys([w('a', 'waiting', 100), w('b', 'running', 0), w('c', 'waiting')])])
      .toEqual(['a:100', 'c:0'])
  })
})

describe('newlyWaiting', () => {
  it('returns waiting workspaces whose spell is new, including a new spell of a known one', () => {
    const prev = waitingKeys([w('a', 'waiting', 100), w('b', 'waiting', 50)])
    const now = [w('a', 'waiting', 100), w('b', 'waiting', 250), w('c', 'waiting', 1), w('d', 'running')]
    expect(newlyWaiting(prev, now).map((x) => x.workspaceId)).toEqual(['b', 'c'])
  })
})
