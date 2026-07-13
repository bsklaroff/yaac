// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { DeletedSessionEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/deletedApi', () => ({ getDeletedSessions: vi.fn() }))
vi.mock('#lib/createSession', () => ({ restartSession: vi.fn() }))
vi.mock('#lib/useProvisionSession', () => ({ useProvisionSession: () => provision }))

import { DeletedSessionsButton } from '#components/DeletedSessionsButton'
import { getDeletedSessions } from '#lib/deletedApi'
import { useUiStore } from '#store'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const entry = (over: Partial<DeletedSessionEntry> = {}): DeletedSessionEntry => ({
  sessionId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  createdAt: '2026-07-13 00:00:00',
  deletedAt: '2026-07-13 01:00:00',
  ...over,
})

const TWO = [
  entry({ sessionId: 's1', title: 'Fix parser', prompt: 'fix the parser bug' }),
  entry({ sessionId: 's2', title: 'Add tests', tool: 'codex' }),
]

beforeEach(() => {
  useUiStore.setState({ deletedOverlayOpen: false, optimisticDeleted: [] })
  vi.clearAllMocks()
  vi.mocked(getDeletedSessions).mockResolvedValue(TWO)
})

afterEach(cleanup)

/** Render the button + overlay and click the trigger to open it. */
function open(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeletedSessionsButton projectSlug="proj" activeSignature="s0" />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Deleted sessions' }))
}

describe('DeletedSessionsButton', () => {
  it('fetches only after the overlay is opened', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DeletedSessionsButton projectSlug="proj" activeSignature="s0" />
      </QueryClientProvider>,
    )
    expect(getDeletedSessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Deleted sessions' }))
    expect(getDeletedSessions).toHaveBeenCalledWith('proj', 100)
  })

  it('shows an empty state when nothing is deleted', async () => {
    vi.mocked(getDeletedSessions).mockResolvedValue([])
    open()
    await waitFor(() => expect(screen.getByText('No deleted sessions')).toBeTruthy())
  })

  it('lists deleted sessions and shows the selected one in the detail pane', async () => {
    open()
    // First row auto-selected → its prompt (detail-only) is visible.
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    // The title appears in both the list row and the detail header.
    expect(screen.getAllByText('Fix parser').length).toBeGreaterThan(0)
    // Switch selection → the first row's prompt leaves the detail pane.
    fireEvent.click(screen.getAllByText('Add tests')[0])
    await waitFor(() => expect(screen.queryByText('fix the parser bug')).toBeNull())
  })

  it('filters the list by the search box', async () => {
    open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'tests' } })
    // 'Fix parser' leaves both the filtered list and the detail pane.
    expect(screen.queryByText('Fix parser')).toBeNull()
    expect(screen.getAllByText('Add tests').length).toBeGreaterThan(0)
  })

  it('restarts a session and closes the overlay', async () => {
    open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    // Detail's Restart → confirm dialog → confirm.
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }))

    expect(provision).toHaveBeenCalledTimes(1)
    expect(provision.mock.calls[0][0]).toBe('proj')
    expect(provision.mock.calls[0][1]).toBe('claude')
    expect(provision.mock.calls[0][2]).toBe('restart')
    expect(provision.mock.calls[0][3]).toBe('s1')
    expect(useUiStore.getState().deletedOverlayOpen).toBe(false)
  })
})
