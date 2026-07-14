// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarRowIds } from '#components/Sidebar'

const session = (sessionId: string, status: 'waiting' | 'running'): { sessionId: string; status: 'waiting' | 'running' } =>
  ({ sessionId, status })

describe('sidebarRowIds', () => {
  it('orders rows provisioning-first, then waiting, then running', () => {
    const rows = sidebarRowIds(
      [{ sessionId: 'prov-1' }],
      [session('run-1', 'running'), session('wait-1', 'waiting'), session('run-2', 'running')],
      [],
    )
    expect(rows).toEqual(['prov-1', 'wait-1', 'run-1', 'run-2'])
  })

  it('excludes optimistically-deleting sessions (pendingDeleteIds)', () => {
    const rows = sidebarRowIds(
      [],
      [session('a', 'waiting'), session('b', 'running')],
      ['a'],
    )
    expect(rows).toEqual(['b'])
  })

  it('excludes server-marked terminating rows (they render but are not selectable)', () => {
    const rows = sidebarRowIds(
      [],
      [{ sessionId: 'a', status: 'running', terminating: true }, session('b', 'running')],
      [],
    )
    expect(rows).toEqual(['b'])
  })

  it('returns an empty list with nothing to show', () => {
    expect(sidebarRowIds([], [], [])).toEqual([])
  })
})
