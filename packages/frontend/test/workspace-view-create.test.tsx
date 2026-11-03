import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { JSX } from 'react'
import { PROMPT_PREVIEW_LENGTH, type ProvisioningWorkspaceEntry, type ServerSnapshot, type StoppedWorkspaceEntry } from '@yaac/shared/types'

// No xterm, no PTY: the terminal pane is a stub.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { WorkspaceView } from '#components/WorkspaceView'
import { rememberOpening } from '#lib/opening'
import { layoutOf, mergeProvisioning, useUiStore } from '#lib/store'
import { useRestartStopped } from '#lib/useStoppedWorkspaces'
import {
  mockFetch, renderWithClient, serverError, sessionEntry, testQueryClient, workspaceEntry, type FetchCall, type FetchMock,
} from './harness'

/*
 * What the main pane shows around a create: the new-workspace pane while
 * nothing is selected, then the create's own pane until the workspace is
 * listed, and for a chat session until its agent is up. The form itself
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

  // The listing cuts a long prompt short, and the tab that sent it has it
  // whole.
  it('shows a failure, with the prompt it was given, and a way to clear it', async () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1' })
    const whole = `fix the parser bug${' and the lexer'.repeat(PROMPT_PREVIEW_LENGTH / 10)}`
    rememberOpening('sess-sent', whole)
    show([creating({ error: 'a tool is missing', sessionId: 'sess-sent', prompt: whole.slice(0, PROMPT_PREVIEW_LENGTH) })])
    expect(screen.getByText(/a tool is missing/)).toBeTruthy()
    expect(screen.getByText(whole)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart without volume' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.called('POST /api/workspace/provisioning/w1/dismiss')).toHaveLength(1))
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  // The server refuses a restart whose volume another running workspace
  // holds before it streams anything, so the row exists only in this tab.
  it('offers to restart without the volume when another workspace holds it', async () => {
    const stopped: StoppedWorkspaceEntry = {
      workspaceId: 'w1', projectId: 'proj', createdAt: '', stoppedAt: '', deathSeenBy: [],
      sessions: [sessionEntry()], conversations: [], groupId: 'g1',
    }
    server.route('POST /api/workspace/restart', ({ body }: FetchCall) => (body as { volume?: null }).volume === null
      ? { type: 'result', result: { workspaceId: 'w1' } }
      : serverError('VOLUME_HELD', 'volume "db" is attached to running workspace abcd1234', 409))
    function Restarting({ entry }: { entry: StoppedWorkspaceEntry }): JSX.Element {
      const restart = useRestartStopped()
      const optimistic = useUiStore((s) => s.optimisticProvisioning)
      return (
        <>
          <button type="button" onClick={() => restart(entry)}>Restart</button>
          <WorkspaceView snapshot={snapshot} provisioning={mergeProvisioning([], optimistic)} />
        </>
      )
    }
    useUiStore.setState({ activeProjectId: 'proj', snapshot })
    renderWithClient(<Restarting entry={stopped} />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(await screen.findByText(/attached to running workspace abcd1234/)).toBeTruthy()
    expect(server.called('POST /api/workspace/restart').map((c) => c.body)).toEqual([{ workspaceId: 'w1' }])

    fireEvent.click(screen.getByRole('button', { name: 'Restart without volume' }))
    await waitFor(() => expect(useUiStore.getState().inFlightProvisions).toEqual([]))
    expect(server.called('POST /api/workspace/restart').map((c) => c.body).at(-1))
      .toEqual({ workspaceId: 'w1', volume: null })
    // The retry is a fresh row in the same place, no longer failed.
    expect(useUiStore.getState().optimisticProvisioning).toEqual([
      expect.objectContaining({ workspaceId: 'w1', kind: 'restart', tool: 'claude', groupId: 'g1' }),
    ])
    expect(useUiStore.getState().optimisticProvisioning[0]).not.toHaveProperty('error')
    expect(screen.queryByRole('button', { name: 'Restart without volume' })).toBeNull()
    expect(useUiStore.getState().selectedWorkspaceId).toBe('w1')
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

  // A chat session is listed before its agent names a conversation, so its
  // pane has no chat yet. It goes on looking like the create, with the
  // message it was opened with, rather than showing acpd's log, which stays
  // a click away. A terminal session shows its agent's terminal at once. A
  // long message the listing cut short shows whole: at once where the tab
  // already holds it (the provisioning row before carried it uncut), else
  // once fetched, connecting meanwhile. A failed fetch leaves the spinner
  // without the message, never the cut one.
  it('draws a chat session whose agent is still starting as the create, with its log a click away', async () => {
    const listed = (mode: 'acp' | 'tui', prompt = 'fix the parser bug', sessionId = 'sess-1'): ServerSnapshot => ({
      ...snapshot,
      workspaces: [workspaceEntry({
        workspaceId: 'w1',
        sessions: [sessionEntry({ mode, prompt, sessionId })],
        terminals: [],
      })],
    })
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w1' })
    renderWithClient(<WorkspaceView snapshot={listed('acp')} provisioning={[]} />)
    expect(screen.getByText('fix the parser bug')).toBeTruthy()
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()
    expect(screen.queryByTestId('terminal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show log' }))
    expect(screen.getByTestId('terminal')).toBeTruthy()

    cleanup()
    renderWithClient(<WorkspaceView snapshot={listed('tui')} provisioning={[]} />)
    expect(screen.queryByText('Starting Claude Code')).toBeNull()
    expect(screen.getByTestId('terminal')).toBeTruthy()

    cleanup()
    const whole = `fix the parser bug${' and the lexer'.repeat(50)}`
    server.route('GET /api/workspace/prompt', (c: FetchCall) => (c.query.get('id') === 'sess-long'
      ? { prompt: whole }
      : serverError('NOT_FOUND', 'no such session', 404)))
    const client = testQueryClient()
    const { rerender } = renderWithClient(
      <WorkspaceView snapshot={snapshot} provisioning={[creating({ sessionId: 'sess-handed', prompt: whole })]} />, client,
    )
    expect(screen.getByText(whole)).toBeTruthy()
    rerender(
      <QueryClientProvider client={client}>
        <WorkspaceView snapshot={listed('acp', whole.slice(0, 300), 'sess-handed')} provisioning={[]} />
      </QueryClientProvider>,
    )
    expect(screen.getByText(whole)).toBeTruthy()
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()

    cleanup()
    renderWithClient(<WorkspaceView snapshot={listed('acp', whole.slice(0, 300), 'sess-long')} provisioning={[]} />)
    expect(screen.getByText('connecting')).toBeTruthy()
    expect(screen.queryByText(whole.slice(0, 300))).toBeNull()
    expect(await screen.findByText(whole)).toBeTruthy()
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()

    cleanup()
    renderWithClient(<WorkspaceView snapshot={listed('acp', whole.slice(0, 300), 'sess-gone')} provisioning={[]} />)
    expect(await screen.findByText('Starting Claude Code')).toBeTruthy()
    expect(screen.queryByText(whole.slice(0, 300))).toBeNull()
    expect(server.called('GET /api/workspace/prompt').map((c) => c.query.get('id'))).toEqual(['sess-long', 'sess-gone'])
  })
})
