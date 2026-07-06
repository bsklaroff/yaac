import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteSessionOptimistic } from '@/frontend/lib/deleteSessionFlow'
import { deleteSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'
import type { SessionListEntry } from '@/shared/types'

vi.mock('@/frontend/lib/createSession', () => ({
  deleteSession: vi.fn(() => Promise.resolve()),
}))

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  vi.mocked(deleteSession).mockClear()
  vi.mocked(deleteSession).mockResolvedValue(undefined)
})

const session = (over: Partial<SessionListEntry> = {}): SessionListEntry => ({
  sessionId: 'sid-1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'waiting',
  createdAt: '2026-07-02 10:00:00',
  blockedHosts: [],
  forwardedPorts: [],
  ...over,
})

describe('deleteSessionOptimistic', () => {
  it('hides the session, clears a matching selection, and fires the delete', () => {
    useUiStore.getState().selectSession('sid-1')

    deleteSessionOptimistic(session())

    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')
    expect(useUiStore.getState().selectedSessionId).toBeNull()
    expect(deleteSession).toHaveBeenCalledWith('sid-1')
  })

  it('leaves an unrelated selection alone', () => {
    useUiStore.getState().selectSession('other')

    deleteSessionOptimistic(session())

    expect(useUiStore.getState().selectedSessionId).toBe('other')
  })

  it('shows the session in the Deleted group only when it has history', () => {
    deleteSessionOptimistic(session({ prompt: 'do a thing', title: 'Thing' }))
    expect(useUiStore.getState().optimisticDeleted).toMatchObject([
      { sessionId: 'sid-1', projectSlug: 'proj', tool: 'claude', prompt: 'do a thing', title: 'Thing' },
    ])

    useUiStore.setState(initial, true)
    deleteSessionOptimistic(session()) // no prompt → nothing to restart into
    expect(useUiStore.getState().optimisticDeleted).toEqual([])
  })

  it('restores the session when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ })
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error('boom'))

    deleteSessionOptimistic(session({ prompt: 'do a thing' }))
    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')

    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().pendingDeleteIds).toEqual([])
    expect(useUiStore.getState().optimisticDeleted).toEqual([])
  })
})
