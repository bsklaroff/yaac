import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stopWorkspaceOptimistic, successorRow } from '#lib/stopWorkspaceFlow'
import { stopWorkspace } from '#lib/createWorkspace'
import { useUiStore } from '#lib/store'
import type { WorkspaceListEntry } from '@yaac/shared/types'

vi.mock('#lib/createWorkspace', () => ({
  stopWorkspace: vi.fn(() => Promise.resolve()),
}))

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  vi.mocked(stopWorkspace).mockClear()
  vi.mocked(stopWorkspace).mockResolvedValue(undefined)
})

const session = (over: Partial<WorkspaceListEntry> = {}): WorkspaceListEntry => ({
  workspaceId: 'sid-1',
  projectId: 'proj',
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

describe('stopWorkspaceOptimistic', () => {
  it('hides the session, selects the row below it, and fires the delete', () => {
    useUiStore.getState().selectWorkspace('sid-1')

    stopWorkspaceOptimistic(session(), ['above', 'sid-1', 'below'])

    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('below')
    expect(stopWorkspace).toHaveBeenCalledWith('sid-1')
  })

  it('selects the row above when the deleted one was last, and nothing when it was alone', () => {
    useUiStore.getState().selectWorkspace('sid-1')
    stopWorkspaceOptimistic(session(), ['above', 'sid-1'])
    expect(useUiStore.getState().selectedWorkspaceId).toBe('above')

    useUiStore.setState(initial, true)
    useUiStore.getState().selectWorkspace('sid-1')
    stopWorkspaceOptimistic(session(), ['sid-1'])
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('moves the selection without navigating there on mobile', () => {
    useUiStore.setState({ selectedWorkspaceId: 'sid-1', mobileScreen: 'workspaces' })

    stopWorkspaceOptimistic(session(), ['sid-1', 'below'])

    expect(useUiStore.getState().selectedWorkspaceId).toBe('below')
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
  })

  it('leaves an unrelated selection alone', () => {
    useUiStore.getState().selectWorkspace('other')

    stopWorkspaceOptimistic(session(), ['sid-1', 'below'])

    expect(useUiStore.getState().selectedWorkspaceId).toBe('other')
  })

  it('shows the session in the Deleted group only when it has history', () => {
    stopWorkspaceOptimistic(session({ prompt: 'do a thing', title: 'Thing' }), [])
    expect(useUiStore.getState().optimisticStopped).toMatchObject([
      { workspaceId: 'sid-1', projectId: 'proj', tool: 'claude', prompt: 'do a thing', title: 'Thing' },
    ])

    useUiStore.setState(initial, true)
    stopWorkspaceOptimistic(session(), []) // no prompt → nothing to restart into
    expect(useUiStore.getState().optimisticStopped).toEqual([])
  })

  it('restores the session when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ })
    vi.mocked(stopWorkspace).mockRejectedValueOnce(new Error('boom'))

    stopWorkspaceOptimistic(session({ prompt: 'do a thing' }), [])
    expect(useUiStore.getState().pendingDeleteIds).toContain('sid-1')

    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().pendingDeleteIds).toEqual([])
    expect(useUiStore.getState().optimisticStopped).toEqual([])
  })
})
