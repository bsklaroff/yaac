// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { useUiStore } from '#store'

const initial = useUiStore.getState()
beforeEach(() => { useUiStore.setState(initial, true) })

describe('useProvisionWorktree', () => {
  it('adds an optimistic provisioning row with the given id and auto-opens it', () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-1', () => Promise.resolve({ worktreeId: 'sid-1' }))
    })

    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { worktreeId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Starting…' },
    ])
    // Auto-open: selected and the project switched so progress shows immediately.
    expect(useUiStore.getState().selectedWorktreeId).toBe('sid-1')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
  })

  // A restart is started from the ghost row inside a group, and the row that
  // replaces it has to be filed there from the first frame — the server's own
  // entry says the same thing, so the swap between them moves nothing.
  it('files the optimistic row in the group it was given', () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      result.current('proj', 'claude', 'restart', 'sid-g', () => Promise.resolve({ worktreeId: 'sid-g' }), 'g1')
    })

    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { worktreeId: 'sid-g', kind: 'restart', groupId: 'g1' },
    ])
  })

  it('streams progress into the optimistic row message', async () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-2', (_sid, onProgress) => {
        onProgress('Pulling image…')
        return Promise.resolve({ worktreeId: 'sid-2' })
      })
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.worktreeId === 'sid-2')
      expect(row?.message).toBe('Pulling image…')
    })
  })

  it('follows the real id when a create claims a prewarmed spare (id swap)', async () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      // op resolves with a DIFFERENT id than requested — a claimed spare.
      result.current('proj', 'claude', 'create', 'requested-id', () => Promise.resolve({ worktreeId: 'spare-id' }))
    })

    await waitFor(() => {
      // Optimistic row for the requested id is dropped...
      expect(useUiStore.getState().optimisticProvisioning.find((e) => e.worktreeId === 'requested-id')).toBeUndefined()
      // ...and the real (claimed) session is selected.
      expect(useUiStore.getState().selectedWorktreeId).toBe('spare-id')
    })
    // The optimistic row is RE-KEYED to the claimed id (not just dropped) so the
    // auto-open survives the gap until the snapshot lists the spare — otherwise
    // App's auto-select would steal the pane back to an existing session.
    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { worktreeId: 'spare-id', projectSlug: 'proj', tool: 'claude', kind: 'create' },
    ])
  })

  it('keeps the row and selection when the result id matches (cold create)', async () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      result.current('proj', 'claude', 'create', 'same-id', () => Promise.resolve({ worktreeId: 'same-id' }))
    })

    // Give the resolved promise a chance to run; the row must NOT be dropped.
    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.worktreeId)).toContain('same-id')
    expect(useUiStore.getState().selectedWorktreeId).toBe('same-id')
  })

  it('surfaces an error on the optimistic row when the op rejects', async () => {
    const { result } = renderHook(() => useProvisionWorktree())

    act(() => {
      result.current('proj', 'codex', 'restart', 'sid-3', () => Promise.reject(new Error('boom')))
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.worktreeId === 'sid-3')
      expect(row?.error).toBe('boom')
    })
    // The row was still added and selected even though the op failed.
    expect(useUiStore.getState().selectedWorktreeId).toBe('sid-3')
  })
})
