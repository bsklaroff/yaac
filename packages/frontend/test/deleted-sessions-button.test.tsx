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

function renderButton(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeletedSessionsButton projectSlug="proj" activeSignature="s0" />
    </QueryClientProvider>,
  )
}

/** Render, wait for the (data-gated) sidebar entry point, and open the overlay. */
async function open(): Promise<void> {
  renderButton()
  fireEvent.click(await screen.findByRole('button', { name: 'Deleted sessions' }))
}

describe('DeletedSessionsButton', () => {
  it('fetches on mount so the sidebar entry point can hide when empty', async () => {
    renderButton()
    // No user interaction — the list is needed up-front to decide visibility.
    await waitFor(() => expect(getDeletedSessions).toHaveBeenCalledWith('proj', 100))
  })

  it('hides the entry point when nothing is deleted', async () => {
    vi.mocked(getDeletedSessions).mockResolvedValue([])
    renderButton()
    await waitFor(() => expect(getDeletedSessions).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Deleted sessions' })).toBeNull()
  })

  it('shows the entry point once deleted sessions exist', async () => {
    renderButton()
    expect(await screen.findByRole('button', { name: 'Deleted sessions' })).toBeTruthy()
  })

  it('lists deleted sessions and shows the selected one in the detail pane', async () => {
    await open()
    // First row auto-selected → its prompt (detail-only) is visible.
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    // The title appears in both the list row and the detail header.
    expect(screen.getAllByText('Fix parser').length).toBeGreaterThan(0)
    // Switch selection → the first row's prompt leaves the detail pane.
    fireEvent.click(screen.getAllByText('Add tests')[0])
    await waitFor(() => expect(screen.queryByText('fix the parser bug')).toBeNull())
  })

  it('filters the list by the search box', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'tests' } })
    // 'Fix parser' leaves both the filtered list and the detail pane.
    expect(screen.queryByText('Fix parser')).toBeNull()
    expect(screen.getAllByText('Add tests').length).toBeGreaterThan(0)
  })

  it('renders a died row with its cause in the list, detail, and restart dialog', async () => {
    vi.mocked(getDeletedSessions).mockResolvedValue([
      entry({
        sessionId: 's3',
        title: 'OOMed run',
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      }),
    ])
    await open()
    // Row subtitle carries the short description (no detail).
    await waitFor(() => expect(
      screen.getByText(/died .* — out of memory \(hit the session memory limit\)/)).toBeTruthy())
    // Detail pane: the timestamp row is labeled Died, and Cause carries the detail.
    expect(screen.getByText('Died')).toBeTruthy()
    expect(screen.getByText('Cause')).toBeTruthy()
    expect(screen.getByText(/out of memory \(hit the session memory limit\) — exit code 137/)).toBeTruthy()
    // Restart dialog mentions the death.
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/This session died: out of memory/)).toBeTruthy()
  })

  it('labels a plain delete as Deleted with no Cause row', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    expect(screen.getByText('Deleted')).toBeTruthy()
    expect(screen.queryByText('Cause')).toBeNull()
  })

  it('restarts a session and closes the overlay', async () => {
    await open()
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
