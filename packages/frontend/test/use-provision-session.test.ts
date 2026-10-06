// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { useUiStore } from '#lib/store'

const initial = useUiStore.getState()
beforeEach(() => { useUiStore.setState(initial, true) })

describe('useProvisionWorkspace', () => {
  it('adds an optimistic provisioning row with the given id and auto-opens it', () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-1', () => Promise.resolve({ workspaceId: 'sid-1' }))
    })

    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { workspaceId: 'sid-1', projectId: 'proj', tool: 'claude', kind: 'create', message: 'Starting…' },
    ])
    // Auto-open: selected and the project switched so progress shows immediately.
    expect(useUiStore.getState().selectedWorkspaceId).toBe('sid-1')
    expect(useUiStore.getState().activeProjectId).toBe('proj')
  })

  // A restart starts from a ghost row inside a group. The optimistic row must
  // be in that group from the first frame so it doesn't jump when the server's
  // row replaces it.
  it('files the optimistic row in the group it was given', () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      result.current('proj', 'claude', 'restart', 'sid-g', () => Promise.resolve({ workspaceId: 'sid-g' }), 'g1')
    })

    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { workspaceId: 'sid-g', kind: 'restart', groupId: 'g1' },
    ])
  })

  it('streams progress into the optimistic row message', async () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-2', (_sid, onProgress) => {
        onProgress('Pulling image…')
        return Promise.resolve({ workspaceId: 'sid-2' })
      })
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.workspaceId === 'sid-2')
      expect(row?.message).toBe('Pulling image…')
    })
  })

  it('records the claim when a create comes back as a prewarmed spare (id swap)', async () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      // The op resolves with a different id than requested (a claimed spare).
      result.current('proj', 'claude', 'create', 'requested-id', () => Promise.resolve({ workspaceId: 'spare-id' }))
    })

    // In flight until the request settles. It is released only after the
    // claim is recorded, so the selection always knows where to follow.
    expect(useUiStore.getState().inFlightProvisions).toEqual(['requested-id'])
    await waitFor(() => {
      expect(useUiStore.getState().inFlightProvisions).toEqual([])
    })
    expect(useUiStore.getState().claims['requested-id']).toBe('spare-id')
    // The requested id's row is dropped and no row stands in for the spare,
    // which would duplicate the server's row. The selection stays on the
    // requested id until the spare is listed; App then hands it over
    // (resolveVacantSelection).
    expect(useUiStore.getState().optimisticProvisioning).toEqual([])
    expect(useUiStore.getState().selectedWorkspaceId).toBe('requested-id')
  })

  it('keeps the row and selection when the result id matches (cold create)', async () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      result.current('proj', 'claude', 'create', 'same-id', () => Promise.resolve({ workspaceId: 'same-id' }))
    })

    // Give the resolved promise a chance to run; the row must NOT be dropped.
    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.workspaceId)).toContain('same-id')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('same-id')
  })

  it('surfaces an error on the optimistic row when the op rejects', async () => {
    const { result } = renderHook(() => useProvisionWorkspace())

    act(() => {
      result.current('proj', 'codex', 'restart', 'sid-3', () => Promise.reject(new Error('boom')))
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.workspaceId === 'sid-3')
      expect(row?.error).toBe('boom')
    })
    // The row was still added and selected even though the op failed.
    expect(useUiStore.getState().selectedWorkspaceId).toBe('sid-3')
  })
})
