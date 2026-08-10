// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { WorktreeListEntry } from '@yaac/shared/types'

vi.mock('#lib/stoppedApi', () => ({ getStoppedWorktrees: vi.fn(() => Promise.resolve([])) }))
vi.mock('#lib/createWorktree', () => ({
  dismissProvisioning: vi.fn(),
  restartWorktree: vi.fn(),
  setWorktreeBackground: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/stopWorktreeFlow', () => ({ stopWorktreeOptimistic: vi.fn() }))
vi.mock('#lib/useProvisionWorktree', () => ({ useProvisionWorktree: () => vi.fn() }))

import { WorktreeList } from '#components/WorktreeList'
import { setWorktreeBackground } from '#lib/createWorktree'
import { useUiStore } from '#store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState(initial, true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const entry = (over: Partial<WorktreeListEntry> = {}): WorktreeListEntry => ({
  worktreeId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  ...over,
})

function renderList(worktrees: WorktreeListEntry[], projectSlug: string | null = 'proj'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorktreeList projectSlug={projectSlug} worktrees={worktrees} provisioning={[]} />
    </QueryClientProvider>,
  )
}

/**
 * The list body the desktop sidebar and the mobile worktrees screen share.
 * Its section/ordering helpers are covered as pure functions in
 * sidebar.test.ts; what matters here is that the rendered body agrees with
 * them and that its row actions work without a hover, which is the only kind
 * of interaction a phone has.
 */
describe('WorktreeList', () => {
  it('renders the triage sections a project’s worktrees fall into', () => {
    renderList([
      entry({ worktreeId: 'a', title: 'Waiting one', status: 'waiting' }),
      entry({ worktreeId: 'b', title: 'Running one', status: 'running' }),
      entry({ worktreeId: 'c', title: 'Pinned one', background: true }),
      entry({ worktreeId: 'd', title: 'Dying one', stopping: true }),
    ])
    expect(screen.getByText('Waiting')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Background')).toBeTruthy()
    expect(screen.getByText('Terminating')).toBeTruthy()
    expect(screen.getByText('Waiting one')).toBeTruthy()
    expect(screen.getByText('Pinned one')).toBeTruthy()
    // A worktree on its way out is a placeholder, not a selectable row.
    expect(screen.getByText('stopping…')).toBeTruthy()
  })

  it('selects a worktree on tap, which is what advances the mobile pane screen', () => {
    renderList([entry({ worktreeId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByText('Fix parser'))
    expect(useUiStore.getState().selectedWorktreeId).toBe('a')
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('exposes pin and delete as real buttons — reachable without a hover', async () => {
    renderList([entry({ worktreeId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByLabelText('Move to background'))
    await waitFor(() => expect(setWorktreeBackground).toHaveBeenCalledWith('proj', 'a', true))

    fireEvent.click(screen.getByLabelText('Delete worktree'))
    expect(await screen.findByText('Delete worktree?')).toBeTruthy()
  })

  it('says what to do when there is nothing to show', () => {
    renderList([])
    expect(screen.getByText('No worktrees yet')).toBeTruthy()

    cleanup()
    renderList([], null)
    expect(screen.getByText('No project selected')).toBeTruthy()
    // jsdom's matchMedia stub reports desktop, so the copy points at the rail.
    expect(screen.getByText('Pick a project from the rail on the left.')).toBeTruthy()
  })
})
