// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { StoppedWorktreeEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/stoppedApi', () => ({
  getStoppedWorktrees: vi.fn(),
  markDeathSeen: vi.fn(),
  markAllDeathsSeen: vi.fn(),
}))
vi.mock('#lib/createWorktree', () => ({ restartWorktree: vi.fn() }))
vi.mock('#lib/useProvisionWorktree', () => ({ useProvisionWorktree: () => provision }))

import { StoppedWorktreesButton } from '#components/StoppedWorktreesButton'
import { getStoppedWorktrees, markAllDeathsSeen, markDeathSeen } from '#lib/stoppedApi'
import { useUiStore } from '#store'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const entry = (over: Partial<StoppedWorktreeEntry> = {}): StoppedWorktreeEntry => ({
  worktreeId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  createdAt: '2026-07-13 00:00:00',
  stoppedAt: '2026-07-13 01:00:00',
  seen: false,
  agentSessions: [],
  ...over,
})

const TWO = [
  entry({ worktreeId: 's1', title: 'Fix parser', prompt: 'fix the parser bug' }),
  entry({ worktreeId: 's2', title: 'Add tests', tool: 'codex' }),
]

beforeEach(() => {
  useUiStore.setState({ stoppedOverlayOpen: false, optimisticStopped: [] })
  vi.clearAllMocks()
  vi.mocked(getStoppedWorktrees).mockResolvedValue(TWO)
  vi.mocked(markDeathSeen).mockResolvedValue(undefined)
  vi.mocked(markAllDeathsSeen).mockResolvedValue(undefined)
})

afterEach(cleanup)

function renderButton(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StoppedWorktreesButton projectSlug="proj" activeSignature="s0" />
    </QueryClientProvider>,
  )
}

/** Render, wait for the (data-gated) sidebar entry point, and open the overlay. */
async function open(): Promise<void> {
  renderButton()
  fireEvent.click(await screen.findByRole('button', { name: 'Stopped worktrees' }))
}

describe('StoppedWorktreesButton', () => {
  it('fetches on mount so the sidebar entry point can hide when empty', async () => {
    renderButton()
    // No user interaction — the list is needed up-front to decide visibility.
    await waitFor(() => expect(getStoppedWorktrees).toHaveBeenCalledWith('proj', 100))
  })

  it('hides the entry point when nothing is deleted', async () => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([])
    renderButton()
    await waitFor(() => expect(getStoppedWorktrees).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Stopped worktrees' })).toBeNull()
  })

  it('shows the entry point once deleted worktrees exist', async () => {
    renderButton()
    expect(await screen.findByRole('button', { name: 'Stopped worktrees' })).toBeTruthy()
  })

  it('lists deleted worktrees and shows the selected one in the detail pane', async () => {
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
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({
        worktreeId: 's3',
        title: 'OOMed run',
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      }),
    ])
    await open()
    // Row subtitle carries the short description (no detail).
    await waitFor(() => expect(
      screen.getByText(/died .* — out of memory \(hit the worktree memory limit\)/)).toBeTruthy())
    // Detail pane: the timestamp row is labeled Died, and Cause carries the detail.
    expect(screen.getByText('Died')).toBeTruthy()
    expect(screen.getByText('Cause')).toBeTruthy()
    expect(screen.getByText(/out of memory \(hit the worktree memory limit\) — exit code 137/)).toBeTruthy()
    // Restart dialog mentions the death.
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/This worktree died: out of memory/)).toBeTruthy()
  })

  it('flags an unseen abnormal death with a notification dot on the entry point', async () => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    renderButton()
    // Dot shows without opening the overlay (title doubles as tooltip + hook).
    expect(await screen.findByTitle('1 worktree died unexpectedly')).toBeTruthy()
  })

  it('shows no notification dot when every deletion was user-initiated', async () => {
    renderButton() // TWO are plain deletes (no deathReason)
    await screen.findByRole('button', { name: 'Stopped worktrees' })
    expect(screen.queryByTitle(/died unexpectedly/)).toBeNull()
  })

  it('marks the death seen server-side and clears the dot once its detail is viewed', async () => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    await open() // sole died row auto-selected → its detail is on screen → seen
    // Persisted via the server, and the cached list is optimistically patched so
    // the dot clears without waiting for a refetch.
    await waitFor(() => expect(markDeathSeen).toHaveBeenCalledWith('proj', 's3'))
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
  })

  it('keeps the dot until each died row is individually viewed', async () => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's1', title: 'Plain delete' }),
      entry({ worktreeId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    await open() // top row (plain delete) auto-selected → the died row stays unseen
    expect(await screen.findByTitle('1 worktree died unexpectedly')).toBeTruthy()
    expect(markDeathSeen).not.toHaveBeenCalled() // the plain delete isn't a death
    fireEvent.click(screen.getAllByText('OOMed run')[0]) // view it → marked seen
    await waitFor(() => expect(markDeathSeen).toHaveBeenCalledWith('proj', 's3'))
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
  })

  it('clears every death at once from the overlay header', async () => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's1', title: 'Plain delete' }),
      entry({ worktreeId: 's3', title: 'OOMed run', deathReason: 'oom' }),
      entry({ worktreeId: 's4', title: 'Evicted run', deathReason: 'evicted' }),
    ])
    await open() // top row is the plain delete → both deaths stay unseen
    expect(await screen.findByTitle('2 worktrees died unexpectedly')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    await waitFor(() => expect(markAllDeathsSeen).toHaveBeenCalledWith('proj'))
    // Optimistic patch: the dot clears without a refetch, and with nothing left
    // unread the button itself goes away.
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull()
    // Selecting a row that is already marked doesn't re-post a per-row ack.
    fireEvent.click(screen.getAllByText('OOMed run')[0])
    await waitFor(() => expect(screen.getByText('Cause')).toBeTruthy())
    expect(markDeathSeen).not.toHaveBeenCalled()
  })

  it('offers no mark-all when every deletion was user-initiated', async () => {
    await open() // TWO are plain deletes (no deathReason)
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull()
  })

  it('labels a plain delete as Stopped with no Cause row', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Cause')).toBeNull()
  })

  it('restarts a worktree and closes the overlay', async () => {
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
    expect(useUiStore.getState().stoppedOverlayOpen).toBe(false)
  })

  it('re-lists a restarted worktree after it is deleted again', async () => {
    // Bug: restarting a worktree left its id in a local mid-restart filter that
    // was never cleared. Because a restart reuses the worktree id, removing that
    // worktree again stayed hidden until a browser reload reset the component.
    // Presence is observed here via the sidebar death dot, whose count is taken
    // from the merged (post-filter) list.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // s1 died and is unseen → the dot shows before the overlay is even opened.
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's1', title: 'OOMed run', deathReason: 'oom' }),
    ])
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <StoppedWorktreesButton projectSlug="proj" activeSignature="sig-a" />
      </QueryClientProvider>,
    )
    expect(await screen.findByTitle('1 worktree died unexpectedly')).toBeTruthy()

    // Restart s1 from the overlay → records it mid-restart and closes the overlay.
    fireEvent.click(await screen.findByRole('button', { name: 'Stopped worktrees' }))
    fireEvent.click(await screen.findByRole('button', { name: /Restart/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restart' }))
    expect(provision).toHaveBeenCalledTimes(1)

    // Restart took hold: s1 is live again and leaves the deleted list. The active
    // set changed, re-keying the query; the refetch comes back empty. That drop
    // must prune s1 from the mid-restart filter.
    vi.mocked(getStoppedWorktrees).mockResolvedValue([])
    rerender(
      <QueryClientProvider client={client}>
        <StoppedWorktreesButton projectSlug="proj" activeSignature="sig-b" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(client.getQueryData(['deleted', 'proj', 'sig-b'])).toEqual([]))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stopped worktrees' })).toBeNull())

    // s1 dies again and re-enters the deleted list. With the stale filter pruned,
    // the death dot must reappear immediately — no browser reload needed.
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      entry({ worktreeId: 's1', title: 'OOMed run', deathReason: 'oom' }),
    ])
    rerender(
      <QueryClientProvider client={client}>
        <StoppedWorktreesButton projectSlug="proj" activeSignature="sig-c" />
      </QueryClientProvider>,
    )
    expect(await screen.findByTitle('1 worktree died unexpectedly')).toBeTruthy()
  })
})
