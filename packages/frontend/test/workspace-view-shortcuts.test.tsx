// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'
import type * as FilesModule from '#lib/files'

// Stub the workspace panes: no xterm, no PTY, and a file listing for the
// explorer.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <div data-testid="terminal" /> }))
vi.mock('#lib/terminalsApi', () => ({
  getWorkspaceTerminals: vi.fn(() => Promise.resolve([])),
  createShellTerminal: vi.fn(),
  killWorkspaceTerminal: vi.fn(),
}))
vi.mock('#lib/files', async (importOriginal) => ({
  ...await importOriginal<typeof FilesModule>(),
  listWorkspaceFiles: vi.fn(() => Promise.resolve({
    paths: ['a.ts'], symlinks: {}, ignored: [], emptyDirs: [], status: {}, truncated: false,
  })),
}))

import { WorkspaceView } from '#components/WorkspaceView'
import { DEFAULT_BINDINGS } from '#lib/shortcuts'
import { shortcutsSuspended, useUiStore } from '#lib/store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const workspace: WorkspaceListEntry = {
  workspaceId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
}
const snapshot = { workspaces: [workspace] } as unknown as ServerSnapshot

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {}, filesFindPending: false })
})
afterEach(cleanup)

function renderView(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorkspaceView snapshot={snapshot} provisioning={[]} />
    </QueryClientProvider>,
  )
}

const altE = (): void => { fireEvent.keyDown(window, { code: 'KeyE', key: 'e', altKey: true }) }
const tabsOf = (): string[] => (useUiStore.getState().layouts.s1 ?? []).flatMap((g) => g.tabs)

describe('WorkspaceView: open-files', () => {
  it('opens the explorer on Alt+E and hands its filter the focus once mounted', async () => {
    renderView()
    altE()
    expect(tabsOf()).toContain('files')
    expect(useUiStore.getState().activeTabs.s1).toBe('files')
    const filter = await screen.findByLabelText('Filter files')
    await waitFor(() => expect(document.activeElement).toBe(filter))
    expect(useUiStore.getState().filesFindPending).toBe(false)
  })

  it('surfaces an explorer that is already open as a hidden tab', () => {
    useUiStore.setState({ layouts: { s1: [{ tabs: ['agent', 'files'], active: 'agent' }] } })
    renderView()
    altE()
    expect(useUiStore.getState().layouts.s1).toEqual([{ tabs: ['agent', 'files'], active: 'files' }])
    expect(useUiStore.getState().filesFindPending).toBe(true)
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

describe('window shortcuts while the create dialog is open', () => {
  it('leave the keypress to the dialog, and resume once it closes', () => {
    renderView()
    useUiStore.getState().openCreateWorkspace({ projectSlug: 'proj', focus: 'prompt' })
    altE()
    expect(tabsOf()).not.toContain('files')

    useUiStore.getState().closeCreateWorkspace()
    altE()
    expect(tabsOf()).toContain('files')
  })

  it('suspends for the dialog and for a rebind being recorded, not otherwise', () => {
    const base = { recordingShortcut: false, createWorkspaceDialog: null }
    expect(shortcutsSuspended(base)).toBe(false)
    expect(shortcutsSuspended({ ...base, recordingShortcut: true })).toBe(true)
    expect(shortcutsSuspended({ ...base, createWorkspaceDialog: { projectSlug: 'proj' } })).toBe(true)
  })
})
