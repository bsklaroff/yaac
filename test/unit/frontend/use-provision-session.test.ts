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
