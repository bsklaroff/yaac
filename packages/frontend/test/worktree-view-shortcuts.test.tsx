// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ServerSnapshot, WorktreeListEntry } from '@yaac/shared/types'
import type * as FilesModule from '#lib/files'

// The panes a workspace mounts, reduced to what these cases look at: no
// xterm, no PTY, and a listing for the explorer.
vi.mock('#components/WorktreeTerminal', () => ({ WorktreeTerminal: () => <div data-testid="terminal" /> }))
vi.mock('#lib/terminalsApi', () => ({
  getWorktreeTerminals: vi.fn(() => Promise.resolve([])),
  createShellTerminal: vi.fn(),
  killWorktreeTerminal: vi.fn(),
}))
vi.mock('#lib/files', async (importOriginal) => ({
  ...await importOriginal<typeof FilesModule>(),
  listWorktreeFiles: vi.fn(() => Promise.resolve({
    paths: ['a.ts'], symlinks: {}, ignored: [], emptyDirs: [], status: {}, truncated: false,
  })),
}))

import { WorktreeView } from '#components/WorktreeView'
import { DEFAULT_BINDINGS } from '#lib/shortcuts'
import { useUiStore } from '#store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const worktree: WorktreeListEntry = {
  worktreeId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
}
const snapshot = { worktrees: [worktree] } as unknown as ServerSnapshot

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorktreeId: 's1', layouts: {}, activeTabs: {}, findPending: null })
})
afterEach(cleanup)

function renderView(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorktreeView snapshot={snapshot} provisioning={[]} />
    </QueryClientProvider>,
  )
}

const altE = (): void => { fireEvent.keyDown(window, { code: 'KeyE', key: 'e', altKey: true }) }
const tabsOf = (): string[] => (useUiStore.getState().layouts.s1 ?? []).flatMap((g) => g.tabs)

describe('WorktreeView: open-files', () => {
  it('opens the explorer on Alt+E and hands its filter the focus once mounted', async () => {
    renderView()
    altE()
    expect(tabsOf()).toContain('files')
    expect(useUiStore.getState().activeTabs.s1).toBe('files')
    const filter = await screen.findByLabelText('Filter files')
    await waitFor(() => expect(document.activeElement).toBe(filter))
    expect(useUiStore.getState().findPending).toBeNull()
  })

  it('surfaces an explorer that is already open as a hidden tab', () => {
    useUiStore.setState({ layouts: { s1: [{ tabs: ['agent', 'files'], active: 'agent' }] } })
    renderView()
    altE()
    expect(useUiStore.getState().layouts.s1).toEqual([{ tabs: ['agent', 'files'], active: 'files' }])
    expect(useUiStore.getState().findPending).toBe('files')
  })

  it('follows a rebinding, and the old chord no longer opens it', () => {
    act(() => {
      useUiStore.getState().setBinding('open-files', { ...DEFAULT_BINDINGS['open-files'], code: 'KeyO' })
    })
    renderView()
    altE()
    expect(tabsOf()).not.toContain('files')
    fireEvent.keyDown(window, { code: 'KeyO', key: 'o', altKey: true })
    expect(tabsOf()).toContain('files')
  })
})
