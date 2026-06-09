// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProvisionSession } from '@/frontend/lib/useProvisionSession'
import { useUiStore } from '@/frontend/store'

const initial = useUiStore.getState()
beforeEach(() => { useUiStore.setState(initial, true) })

describe('useProvisionSession', () => {
  it('shows the creating placeholder, then keeps it (with id) and selects on resolve', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'claude', () => Promise.resolve({ sessionId: 'sid-1' }))
    })
    // Optimistic placeholder appears synchronously.
    expect(useUiStore.getState().creating).toMatchObject({ projectSlug: 'proj', tool: 'claude' })

    await waitFor(() => {
      expect(useUiStore.getState().creating?.sessionId).toBe('sid-1')
    })
    // Selected so it opens once the snapshot includes it; `creating` is kept
    // until then (App clears it on hand-off).
    expect(useUiStore.getState().selectedSessionId).toBe('sid-1')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
  })

  it('surfaces an error on the placeholder when the op rejects', async () => {
    const { result } = renderHook(() => useProvisionSession())

    act(() => {
      result.current('proj', 'codex', () => Promise.reject(new Error('boom')))
    })

    await waitFor(() => {
      expect(useUiStore.getState().creating?.error).toBe('boom')
    })
    expect(useUiStore.getState().selectedSessionId).toBeNull()
  })
})
