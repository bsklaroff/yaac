import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ProvisioningWorkspaceEntry, ServerSnapshot } from '@yaac/shared/types'

// No xterm, no PTY: the terminal pane is a stub.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { WorkspaceView } from '#components/WorkspaceView'
import { layoutOf, useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, workspaceEntry, type FetchMock } from './harness'

/*
 * What the main pane shows around a create: the new-workspace pane while
 * nothing is selected, then the create's own pane until the workspace is
 * listed, and for a chat workspace until its agent is up. The form itself
 * is new-workspace-pane.test.tsx's.
 */

const initial = useUiStore.getState()
let server: FetchMock
beforeEach(() => {
  server = mockFetch({
    'GET /api/auth/list': { gitCredentials: [], toolAuth: [] },
    'GET /api/project/proj/branches': { branches: ['main'], defaultBranch: 'main' },
    'POST /api/workspace/stop': {},
    'POST /api/workspace/provisioning/w1/dismiss': {},
  })
})
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

const snapshot = {
  driver: 'k8s',
  workspaces: [],
  provisioning: [],
  projects: [{ id: 'proj', name: 'widgets', stoppedCount: 3, createDefaults: {} }],
  queuedWorkspaces: [],
  heldWorkspaces: [],
  draftWorkspaces: [],
  routines: [],
} as unknown as ServerSnapshot

const creating = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'w1',
  projectId: 'proj',
  tool: 'claude',
  kind: 'create',
  model: 'claude-opus-5-5',
  modelName: 'Opus 5.5',
  message: 'Fetching latest from remote...',
  createdAt: '2026-01-01 00:00:00',
  prompt: 'fix the parser bug',
  ...over,
})

function show(provisioning: ProvisioningWorkspaceEntry[] = []): void {
  useUiStore.setState({ snapshot })
  renderWithClient(<WorkspaceView snapshot={snapshot} provisioning={provisioning} />)
}

describe('WorkspaceView around a create', () => {
  it('starts a new workspace whenever nothing is selected, workspaces or not', () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: null })
    show()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Prompt').placeholder).toBe('Message the agent…')
    expect(screen.getByRole('heading').textContent).toBe('New workspace')
  })

  // Drawn as the chat it becomes: the prompt, then the spinner with the
  // create's progress in place of "working".
  it('shows a create as its prompt and progress under its agent\'s tab, and stops it', async () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1' })
    show([creating()])
    expect(screen.getByText('Claude · Opus 5.5')).toBeTruthy()
    expect(screen.getByText('fix the parser bug')).toBeTruthy()
    expect(screen.getByText('Fetching latest from remote')).toBeTruthy()
    expect(screen.getByText(/in widgets/)).toBeTruthy()
    expect(screen.queryByLabelText('Prompt')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(server.called('POST /api/workspace/stop')).toHaveLength(1))
    expect(server.called('POST /api/workspace/stop')[0].body).toEqual({ workspaceId: 'w1' })
    // A stopped create keeps its prompt as a draft, so the pane moves on.
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('shows a restart as progress with no prompt, and a stopping one without Stop', () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1' })
    show([creating({ kind: 'restart', prompt: undefined, message: 'Starting Claude...', stopping: true })])
    expect(screen.getByText('Stopping')).toBeTruthy()
    expect(screen.getByText('Restarting Claude · Opus 5.5 workspace in widgets')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows a failure, with the prompt it was given, and a way to clear it', async () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1' })
    show([creating({ error: 'a tool is missing' })])
    expect(screen.getByText(/a tool is missing/)).toBeTruthy()
    expect(screen.getByText('fix the parser bug')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.called('POST /api/workspace/provisioning/w1/dismiss')).toHaveLength(1))
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  // Started from the new-workspace pane's bar for a pane, it opens that pane
  // once the workspace is listed, and only once.
  it('opens the pane a create was started for once its workspace is listed', async () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1', launches: { w1: { pane: 'files' } } })
    show([creating()])
    expect(screen.getByText(/then opening Files$/)).toBeTruthy()

    cleanup()
    const listed: ServerSnapshot = { ...snapshot, workspaces: [workspaceEntry({ workspaceId: 'w1', terminals: [] })] }
    useUiStore.setState({ snapshot: listed })
    renderWithClient(<WorkspaceView snapshot={listed} provisioning={[]} />)
    await waitFor(() => expect(useUiStore.getState().launches).toEqual({}))
    const st = useUiStore.getState()
    expect(layoutOf(st.layouts, 'w1').flatMap((c) => c.tabs)).toContain('files')
    expect(st.activeTabs.w1).toBe('files')
  })

  // A chat workspace is listed before its agent names a conversation, so
  // there is no chat pane yet. It goes on looking like the create rather
  // than showing acpd's log, which stays a click away. A terminal workspace
  // shows its agent's terminal at once.
  it('draws a chat workspace whose agent is still starting as the create, with its log a click away', () => {
    const listed = (mode: 'acp' | 'tui'): ServerSnapshot =>
      ({ ...snapshot, workspaces: [workspaceEntry({ workspaceId: 'w1', mode, terminals: [] })] })
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1', launches: { w1: { prompt: 'fix the parser bug' } } })
    renderWithClient(<WorkspaceView snapshot={listed('acp')} provisioning={[]} />)
    expect(screen.getByText('fix the parser bug')).toBeTruthy()
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()
    expect(screen.queryByTestId('terminal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show log' }))
    expect(screen.getByTestId('terminal')).toBeTruthy()

    // Another client, or this one after a reload, has the prompt the
    // workspace holds for its conversation.
    cleanup()
    useUiStore.setState({ launches: {} })
    const held: ServerSnapshot = {
      ...snapshot, workspaces: [workspaceEntry({ workspaceId: 'w1', mode: 'acp', prompt: 'port the lexer', terminals: [] })],
    }
    renderWithClient(<WorkspaceView snapshot={held} provisioning={[]} />)
    // In the header, and as the chat's opening message.
    expect(screen.getAllByText('port the lexer')).toHaveLength(2)

    cleanup()
    renderWithClient(<WorkspaceView snapshot={listed('tui')} provisioning={[]} />)
    expect(screen.queryByText('Starting Claude Code')).toBeNull()
    expect(screen.getByTestId('terminal')).toBeTruthy()
  })
})
