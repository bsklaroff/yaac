import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import type { PortMapping, ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

// Stub the terminal pane: no xterm, no PTY. A textarea, as xterm's input
// is, so focus can land in it.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { WorkspaceView } from '#components/WorkspaceView'
import { DEFAULT_BINDINGS } from '#lib/shortcuts'
import { useUiStore } from '#lib/store'
import { isPreviewTarget, previewTarget } from '#lib/preview'
import { mockFetch, renderWithClient, type FetchMock } from './harness'


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
let fetchMock: FetchMock
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {}, findPending: null })
  // No changes, and a one-file listing for the explorer.
  fetchMock = mockFetch({
    'GET /api/workspace/s1/changes': {
      base: 'abc', baseResolved: true, files: [], diff: '', truncated: false, branch: 'main', comparison: null,
      listing: {
        version: 'v1', paths: ['a.ts'], symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false,
      },
    },
  })
})

function renderView(forwardedPorts: PortMapping[] = []): void {
  const snap = forwardedPorts.length ? { workspaces: [{ ...workspace, forwardedPorts }] } as unknown as ServerSnapshot : snapshot
  renderWithClient(<WorkspaceView snapshot={snap} provisioning={[]} />)
}

const altE = (): void => { fireEvent.keyDown(window, { code: 'KeyE', key: 'e', altKey: true }) }
const tabsOf = (): string[] => (useUiStore.getState().layouts.s1 ?? []).flatMap((g) => g.tabs)
const previewTabs = (): string[] => tabsOf().filter(isPreviewTarget)

describe('WorkspaceView: open-files', () => {
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

describe('WorkspaceView: open-changes', () => {
  it('opens the Changes pane on Alt+G or its header button, apart from the explorer', async () => {
    renderView()
    altE()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Filter files')))
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g', altKey: true })
    expect(tabsOf()).toEqual(['agent', 'files', 'changes'])
    expect(useUiStore.getState().activeTabs.s1).toBe('changes')
    const filter = await screen.findByLabelText('Filter changed files')
    await waitFor(() => expect(document.activeElement).toBe(filter))

    act(() => useUiStore.getState().focusTerminal('s1', 'agent'))
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    expect(useUiStore.getState().activeTabs.s1).toBe('changes')
  })
})

describe('window shortcuts while a rebind is recorded', () => {
  it('leave the keypress to the recorder, and resume once it is done', () => {
    renderView()
    useUiStore.setState({ recordingShortcut: true })
    altE()
    expect(tabsOf()).not.toContain('files')

    useUiStore.setState({ recordingShortcut: false })
    altE()
    expect(tabsOf()).toContain('files')
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
    // 3000 is reached here at another port, so its row shows both.
    renderView([{ containerPort: 3000, hostPort: 3001 }, port(5173)])
    const terminal = focusTerminal()

    altP()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([':3000→:3001', ':5173'])
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(items[0], { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(terminal))
    expect(previewTabs()).toEqual([])

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
    await waitFor(() => expect(previewTabs()).toEqual([previewTarget(3000)]))

    // Picking another port opens a second pane beside it; picking one
    // already open focuses it.
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: ':5173' }))
    await waitFor(() => expect(previewTabs()).toEqual([previewTarget(3000), previewTarget(5173)]))
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: ':3000→:3001' }))
    await waitFor(() => expect(useUiStore.getState().activeTabs.s1).toBe(previewTarget(3000)))
    expect(previewTabs()).toEqual([previewTarget(3000), previewTarget(5173)])
  })

  it('with one port, opens the pane on it', () => {
    renderView([port(3000)])
    focusTerminal()
    altP()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(previewTabs()).toEqual([previewTarget(3000)])
  })

  it('keeps a pane on its port while that port is not forwarded, and closes it when stopped', async () => {
    // Another window stopped 5173: only the snapshot says so. A saved
    // layout restores the pane on the port it showed.
    act(() => useUiStore.getState().openPreview('s1', 5173))
    renderView([port(3000)])
    expect(screen.getAllByText('Preview :5173').length).toBeGreaterThan(0)
    expect(screen.getByText('Waiting for the dev server on :5173…')).toBeTruthy()

    cleanup()
    fetchMock.route('POST /api/workspace/s1/unforward-port', {})
    act(() => useUiStore.getState().openPreview('s1', 3000))
    renderView([port(3000), port(5173)])
    expect(screen.queryByText(/Waiting for the dev server/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop forwarding port 3000' }))
    await waitFor(() => expect(previewTabs()).toEqual([previewTarget(5173)]))
    expect(fetchMock.called('POST /api/workspace/s1/unforward-port')[0].body).toEqual({ containerPort: 3000 })
  })

  it('with no ports, opens nothing', () => {
    renderView()
    focusTerminal()
    altP()
    expect(previewTabs()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
  })
})

describe('WorkspaceView: preview outside the desktop app', () => {
  const ports: PortMapping[] = [{ containerPort: 3000, hostPort: 3000 }, { containerPort: 5173, hostPort: 15173 }]
  afterEach(() => { delete (window as unknown as { yaacWindow?: unknown }).yaacWindow })

  it('hands the picked port to the iPhone app instead of opening a pane', async () => {
    const openPreview = vi.fn()
    ;(window as unknown as { yaacWindow: unknown }).yaacWindow = { openExternal: vi.fn(), openPreview }
    renderView(ports)

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    // The phone's own port is its preview's to show, so the row names the workspace's.
    fireEvent.click(await screen.findByRole('menuitem', { name: ':5173' }))
    expect(openPreview).toHaveBeenCalledWith('s1', { containerPort: 5173, hostPort: 15173 })

    // Alt+P with several ports opens the same menu; with one it goes straight there.
    cleanup()
    renderView([ports[0]])
    fireEvent.keyDown(window, { code: 'KeyP', key: 'p', altKey: true })
    expect(openPreview).toHaveBeenLastCalledWith('s1', ports[0])
    expect(previewTabs()).toEqual([])
  })

  it('drops a preview pane a saved layout restores, which could never load here', () => {
    useUiStore.setState({ layouts: { s1: [{ tabs: ['agent', previewTarget(3000)], active: previewTarget(3000) }] } })
    renderView(ports)
    expect(tabsOf()).toEqual(['agent'])
  })

  it('offers no preview in a browser, which cannot reach a forward', () => {
    renderView(ports)
    fireEvent.keyDown(window, { code: 'KeyP', key: 'p', altKey: true })
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(previewTabs()).toEqual([])
  })
})
