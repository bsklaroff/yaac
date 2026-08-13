import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stopWorktreeOptimistic, successorRow } from '#lib/stopWorktreeFlow'
import { stopWorktree } from '#lib/createWorktree'
import { useUiStore } from '#store'
import type { WorktreeListEntry } from '@yaac/shared/types'

vi.mock('#lib/createWorktree', () => ({
  stopWorktree: vi.fn(() => Promise.resolve()),
}))

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  vi.mocked(stopWorktree).mockClear()
  vi.mocked(stopWorktree).mockResolvedValue(undefined)
})

const session = (over: Partial<WorktreeListEntry> = {}): WorktreeListEntry => ({
  worktreeId: 'sid-1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'waiting',
  createdAt: '2026-07-02 10:00:00',
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  agentSessions: [],
  ...over,
})

describe('successorRow', () => {
  it('takes the row below, falling back to the one above at the bottom', () => {
    expect(successorRow(['a', 'sid-1', 'b'], 'sid-1')).toBe('b')
    expect(successorRow(['a', 'sid-1'], 'sid-1')).toBe('a')
    expect(successorRow(['sid-1'], 'sid-1')).toBeNull()
  })

  it('has nowhere to go for a row that isn\'t in the list', () => {
    expect(successorRow(['a', 'b'], 'sid-1')).toBeNull()
    expect(successorRow([], 'sid-1')).toBeNull()
  })
})

describe('stopWorktreeOptimistic', () => {
  it('hides the session, selects the row below it, and fires the delete', () => {
    useUiStore.getState().selectWorktree('sid-1')

    stopWorktreeOptimistic(session(), ['above', 'sid-1', 'below'])

    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')
    expect(useUiStore.getState().selectedWorktreeId).toBe('below')
    expect(stopWorktree).toHaveBeenCalledWith('sid-1')
  })

  it('selects the row above when the deleted one was last, and nothing when it was alone', () => {
    useUiStore.getState().selectWorktree('sid-1')
    stopWorktreeOptimistic(session(), ['above', 'sid-1'])
    expect(useUiStore.getState().selectedWorktreeId).toBe('above')

    useUiStore.setState(initial, true)
    useUiStore.getState().selectWorktree('sid-1')
    stopWorktreeOptimistic(session(), ['sid-1'])
    expect(useUiStore.getState().selectedWorktreeId).toBeNull()
  })

  it('moves the selection without navigating there on mobile', () => {
    useUiStore.setState({ selectedWorktreeId: 'sid-1', mobileScreen: 'worktrees' })

    stopWorktreeOptimistic(session(), ['sid-1', 'below'])

    expect(useUiStore.getState().selectedWorktreeId).toBe('below')
    expect(useUiStore.getState().mobileScreen).toBe('worktrees')
  })

  it('leaves an unrelated selection alone', () => {
    useUiStore.getState().selectWorktree('other')

    stopWorktreeOptimistic(session(), ['sid-1', 'below'])

    expect(useUiStore.getState().selectedWorktreeId).toBe('other')
  })

  it('shows the session in the Deleted group only when it has history', () => {
    stopWorktreeOptimistic(session({ prompt: 'do a thing', title: 'Thing' }), [])
    expect(useUiStore.getState().optimisticStopped).toMatchObject([
      { worktreeId: 'sid-1', projectSlug: 'proj', tool: 'claude', prompt: 'do a thing', title: 'Thing' },
    ])

    useUiStore.setState(initial, true)
    stopWorktreeOptimistic(session(), []) // no prompt → nothing to restart into
    expect(useUiStore.getState().optimisticStopped).toEqual([])
  })

  it('restores the session when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ })
    vi.mocked(stopWorktree).mockRejectedValueOnce(new Error('boom'))

    stopWorktreeOptimistic(session({ prompt: 'do a thing' }), [])
    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')

    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().pendingDeleteIds).toEqual([])
    expect(useUiStore.getState().optimisticStopped).toEqual([])
  })
})
