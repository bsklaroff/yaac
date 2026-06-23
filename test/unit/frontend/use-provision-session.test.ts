// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProvisionSession } from '@/frontend/lib/useProvisionSession'
import { useUiStore } from '@/frontend/store'

const initial = useUiStore.getState()
beforeEach(() => { useUiStore.setState(initial, true) })

describe('useProvisionSession', () => {
  it('adds an optimistic provisioning row with the given id and auto-opens it', () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-1', () => Promise.resolve({ sessionId: 'sid-1' }))
    })

    expect(useUiStore.getState().optimisticProvisioning).toMatchObject([
      { sessionId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Starting…' },
    ])
    // Auto-open: selected and the project switched so progress shows immediately.
    expect(useUiStore.getState().selectedSessionId).toBe('sid-1')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
  })

  it('streams progress into the optimistic row message', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'claude', 'create', 'sid-2', (_sid, onProgress) => {
        onProgress('Pulling image…')
        return Promise.resolve({ sessionId: 'sid-2' })
      })
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.sessionId === 'sid-2')
      expect(row?.message).toBe('Pulling image…')
    })
  })

  it('follows the real id when a create claims a prewarmed spare (id swap)', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      // op resolves with a DIFFERENT id than requested — a claimed spare.
      result.current('proj', 'claude', 'create', 'requested-id', () => Promise.resolve({ sessionId: 'spare-id' }))
    })

    await waitFor(() => {
      // Optimistic row for the requested id is dropped...
      expect(useUiStore.getState().optimisticProvisioning.find((e) => e.sessionId === 'requested-id')).toBeUndefined()
      // ...and the real (claimed) session is selected.
      expect(useUiStore.getState().selectedSessionId).toBe('spare-id')
    })
  })

  it('keeps the row and selection when the result id matches (cold create)', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'claude', 'create', 'same-id', () => Promise.resolve({ sessionId: 'same-id' }))
    })

    // Give the resolved promise a chance to run; the row must NOT be dropped.
    await new Promise((r) => setTimeout(r, 0))
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.sessionId)).toContain('same-id')
    expect(useUiStore.getState().selectedSessionId).toBe('same-id')
  })

  it('surfaces an error on the optimistic row when the op rejects', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'codex', 'restart', 'sid-3', () => Promise.reject(new Error('boom')))
    })

    await waitFor(() => {
      const row = useUiStore.getState().optimisticProvisioning.find((e) => e.sessionId === 'sid-3')
      expect(row?.error).toBe('boom')
    })
    // The row was still added and selected even though the op failed.
    expect(useUiStore.getState().selectedSessionId).toBe('sid-3')
  })
})
