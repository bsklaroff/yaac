import { describe, it, expect } from 'vitest'
import { newlyWaiting, waitingKeys } from '#waiting'
import type { SessionEntry, WorkspaceListEntry } from '#types'

type W = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs' | 'sessions'>
type S = Pick<SessionEntry, 'sessionId' | 'status' | 'waitingSinceMs'>
const s = (sessionId: string, status: S['status'], waitingSinceMs?: number): SessionEntry =>
  ({ sessionId, status, waitingSinceMs }) as SessionEntry
const w = (workspaceId: string, status: W['status'], waitingSinceMs?: number, sessions: SessionEntry[] = []): W =>
  ({ workspaceId, status, waitingSinceMs, sessions })

describe('waitingKeys', () => {
  // A waiting session keys its own spell; a waiting workspace none of whose
  // sessions has a status yet keys its own, 0 when the start is missing.
  it('keys each waiting session by its spell, and a workspace waiting with none by its own', () => {
    expect([...waitingKeys([
      w('a', 'waiting', 100, [s('a1', 'waiting', 100), s('a2', 'running'), s('a3', 'waiting', 300)]),
      w('b', 'running', 0, [s('b1', 'running')]),
      w('c', 'waiting', undefined, [s('c1', undefined)]),
    ])]).toEqual(['a1:100', 'a3:300', 'c:0'])
  })
})

describe('newlyWaiting', () => {
  // A second session finishing while a sibling already waits is a new spell
  // of its own, though the workspace's earliest spell is unchanged.
  it('returns workspaces with a new spell, including a sibling session starting to wait', () => {
    const prev = waitingKeys([
      w('a', 'waiting', 100, [s('a1', 'waiting', 100), s('a2', 'running')]),
      w('b', 'waiting', 50, [s('b1', 'waiting', 50)]),
    ])
    const now = [
      w('a', 'waiting', 100, [s('a1', 'waiting', 100), s('a2', 'waiting', 400)]),
      w('b', 'waiting', 50, [s('b1', 'waiting', 50)]),
      w('c', 'waiting', 1),
      w('d', 'running'),
    ]
    expect(newlyWaiting(prev, now).map((x) => x.workspaceId)).toEqual(['a', 'c'])
  })
})
