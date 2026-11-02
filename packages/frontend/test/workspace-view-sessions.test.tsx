import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { WorkspaceListEntry } from '@yaac/shared/types'

// No xterm, no sockets: the terminal and chat panes are stubs naming what
// they were given.
vi.mock('#components/WorkspaceTerminal', () => ({
  WorkspaceTerminal: ({ target }: { target: string }) => <div data-testid="terminal">{target}</div>,
}))
vi.mock('#components/WorkspaceChat', () => ({
  WorkspaceChat: ({ conversationId }: { conversationId: string }) => <div data-testid="chat">{conversationId}</div>,
}))

import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import {
  conversation, mockFetch, renderWithClient, serverSnapshot, sessionEntry, TEST_USER_ID, workspaceEntry, type FetchMock,
} from './harness'

/*
 * A workspace's sessions as panes (docs/sessions.md): each in its mode's
 * renderer, each closable on its own, an exited one resumable, and a
 * workspace with none showing what it can start.
 */

const CLOSE = 'POST /api/workspace/s1/sessions/sa/close'
const RESUME = 'POST /api/workspace/s1/sessions/sa/resume'
const OPEN = 'POST /api/workspace/s1/sessions'
const SEEN = 'POST /api/workspace/mark-waiting-seen'

const initial = useUiStore.getState()
let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {}, viewMode: 'tabs' })
  server = mockFetch({
    'GET /api/workspace/s1/changes': {
      base: 'abc', baseResolved: true, files: [], diff: '', truncated: false, branch: 'main', comparison: null,
      listing: { version: 'v1', paths: [], symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false },
    },
    [CLOSE]: undefined,
    [RESUME]: undefined,
    [OPEN]: { sessionId: 'sn', workspaceId: 's1' },
    [SEEN]: { marked: true },
  })
})
afterEach(() => {
  cleanup()
})

function show(over: Partial<WorkspaceListEntry>): void {
  const snapshot = serverSnapshot({ workspaces: [workspaceEntry({ terminals: [], ...over })] })
  useUiStore.setState({ snapshot })
  renderWithClient(<WorkspaceView snapshot={snapshot} provisioning={[]} />)
}

describe('WorkspaceView sessions', () => {
  it('draws each session in its mode\'s pane, a chat on its conversation and a terminal on its window', () => {
    show({
      sessions: [
        sessionEntry({ sessionId: 'sa', conversationId: 'conv-a' }),
        sessionEntry({ sessionId: 'sb', mode: 'tui', tool: 'codex', window: 'codex-sb', ordinal: 1 }),
      ],
    })
    expect(screen.getByTestId('chat').textContent).toBe('conv-a')
    expect(screen.getByTestId('terminal').textContent).toBe('session:codex-sb')
    expect(screen.getByRole('button', { name: 'Close session Claude' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close session Codex' })).toBeTruthy()
  })

  it('closes an idle session at once, and asks first about one mid-turn', async () => {
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'waiting' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close session Claude' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(1))

    cleanup()
    useUiStore.setState({ layouts: {} })
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'running' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close session Claude' }))
    expect(await screen.findByText(/Its agent stops mid-turn/)).toBeTruthy()
    expect(server.called(CLOSE)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(2))
  })

  it('keeps an exited session\'s pane, to resume or close it', async () => {
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', exited: true })] })
    expect(screen.getByText('Claude exited.')).toBeTruthy()
    expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(server.called(RESUME)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(1))
  })

  it('shows a workspace with no session what it can start, and resumes an earlier conversation', async () => {
    show({ conversations: [conversation({ conversationId: 'old', prompt: 'fix the parser', active: false })] })
    expect(screen.getByText('No agent is running here')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    expect(screen.getByText('fix the parser')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(server.called(OPEN)).toHaveLength(1))
    expect(server.called(OPEN)[0].body).toEqual({ resume: 'old' })

    // New session opens the create form aimed at this workspace.
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(useUiStore.getState().newWorkspace).toMatchObject({ projectId: 'proj', inWorkspace: 's1' })
  })

  it('marks a waiting session read once its pane is shown, and only that one', async () => {
    show({
      sessions: [
        sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'waiting', waitingSinceMs: 7 }),
        sessionEntry({ sessionId: 'sb', mode: 'tui', window: 'claude-sb', status: 'waiting', waitingSinceMs: 9, ordinal: 1 }),
      ],
    })
    await waitFor(() => expect(server.called(SEEN)).toHaveLength(1))
    expect(server.called(SEEN)[0].body).toEqual({ sessionId: 'sa', waitingSinceMs: 7 })
    const sessions = useUiStore.getState().snapshot?.workspaces[0].sessions ?? []
    expect(sessions.map((s) => s.waitingSeenBy)).toEqual([[TEST_USER_ID], undefined])
  })
})
