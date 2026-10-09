// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import type { PortMapping, ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

// Stub the terminal pane: no xterm, no PTY. A textarea, as xterm's input
// is, so focus can land in it.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { WorkspaceView } from '#components/WorkspaceView'
import { DEFAULT_BINDINGS } from '#lib/shortcuts'
import { shortcutsSuspended, useUiStore } from '#lib/store'
import { mockFetch, renderWithClient } from './harness'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const workspace: WorkspaceListEntry = {
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  terminals: [],
}
const snapshot = { workspaces: [workspace] } as unknown as ServerSnapshot

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {}, filesFindPending: false })
  // No changes, and a one-file listing for the explorer.
  mockFetch({
    'GET /api/workspace/s1/changes': {
      base: 'abc', baseResolved: true, files: [], diff: '', truncated: false, branch: 'main', comparison: null,
      listing: {
        version: 'v1', paths: ['a.ts'], symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false,
      },
    },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderView(forwardedPorts: PortMapping[] = []): void {
  const snap = forwardedPorts.length ? { workspaces: [{ ...workspace, forwardedPorts }] } as unknown as ServerSnapshot : snapshot
  renderWithClient(<WorkspaceView snapshot={snap} provisioning={[]} />)
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
    useUiStore.getState().openCreateWorkspace({ projectId: 'proj', focus: 'prompt' })
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
    expect(shortcutsSuspended({ ...base, createWorkspaceDialog: { projectId: 'proj' } })).toBe(true)
  })
})

describe('WorkspaceView: open-preview', () => {
  const port = (n: number): PortMapping => ({ containerPort: n, hostPort: n })
  const altP = (): void => { fireEvent.keyDown(document.activeElement ?? window, { code: 'KeyP', key: 'p', altKey: true }) }
  const focusTerminal = (): HTMLElement => {
    const terminal = screen.getByTestId('terminal')
    terminal.focus()
    return terminal
  }

  // The embedded preview, and so the port menu, is the desktop app's.
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Electron/33.0.0')
  })
  afterEach(() => vi.restoreAllMocks())

  it('with several ports, offers them in a menu that returns focus where Alt+P was pressed', async () => {
    renderView([port(3000), port(5173)])
    const terminal = focusTerminal()

    altP()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([':3000', ':5173'])
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(items[0], { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(terminal))
    expect(tabsOf()).not.toContain('preview')

    // A second Alt+P closes the menu the same way.
    altP()
    const reopened = await screen.findAllByRole('menuitem')
    await waitFor(() => expect(document.activeElement).toBe(reopened[0]))
    altP()
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(terminal))

    // Enter on the highlighted first port opens the pane on it.
    altP()
    const first = (await screen.findAllByRole('menuitem'))[0]
    await waitFor(() => expect(document.activeElement).toBe(first))
    fireEvent.keyDown(first, { key: 'Enter' })
    await waitFor(() => expect(tabsOf()).toContain('preview'))
    expect(useUiStore.getState().previewPort.s1).toBe(3000)

    // The button's pick switches the open pane to another port.
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: ':5173' }))
    await waitFor(() => expect(useUiStore.getState().previewPort.s1).toBe(5173))
    expect(tabsOf().filter((t) => t === 'preview')).toHaveLength(1)
  })

  it('with one port, opens the pane on it, replacing a port no longer forwarded', () => {
    useUiStore.setState({ previewPort: { s1: 5173 } })
    renderView([port(3000)])
    focusTerminal()
    altP()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(tabsOf()).toContain('preview')
    expect(useUiStore.getState().previewPort.s1).toBe(3000)
  })

  it('with no ports, opens nothing', () => {
    renderView()
    focusTerminal()
    altP()
    expect(tabsOf()).not.toContain('preview')
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
  })
})
