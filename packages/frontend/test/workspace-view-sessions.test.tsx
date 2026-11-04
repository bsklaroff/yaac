import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, cleanup, waitFor, fireEvent, type RenderResult } from '@testing-library/react'
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
  agentEvent, conversation, mockFetch, renderWithClient, serverError, serverSnapshot, sessionEntry, TEST_USER_ID,
  testQueryClient, workspaceEntry, type FetchMock,
} from './harness'

/*
 * A workspace's sessions as panes (docs/sessions.md): each in its mode's
 * renderer, each closable on its own, an exited one resumable, a closed
 * one's conversation read and resumed from the History pane, and a
 * workspace with none showing what it can start.
 */

const CLOSE = 'POST /api/workspace/s1/sessions/sa/close'
const RESUME = 'POST /api/workspace/s1/sessions/sa/resume'
const OPEN = 'POST /api/workspace/s1/sessions'
const SEEN = 'POST /api/workspace/mark-waiting-seen'
const OLD_TRANSCRIPT = 'GET /api/workspace/s1/conversations/old/transcript'

const initial = useUiStore.getState()
let server: FetchMock
let client = testQueryClient()
beforeEach(() => {
  client = testQueryClient()
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
    [OLD_TRANSCRIPT]: { page: 0, events: [agentEvent(0, 'the parser is fixed')] },
    [OLD_TRANSCRIPT.replace('old', 'older')]: { page: 0, events: [agentEvent(0, 'the docs are tidy')] },
  })
})
afterEach(() => {
  cleanup()
})

/** Render the workspace as `over` describes; called again with the same
 *  `view`, it rerenders the mounted view on the new snapshot. */
function show(over: Partial<WorkspaceListEntry>, view?: RenderResult): RenderResult {
  const snapshot = serverSnapshot({ workspaces: [workspaceEntry({ terminals: [], ...over })] })
  useUiStore.setState({ snapshot })
  const ui = <WorkspaceView snapshot={snapshot} provisioning={[]} />
  if (view === undefined) return renderWithClient(ui, client)
  view.rerender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return view
}

/** Conversations closed sessions left, and one an open session holds. */
const closed = conversation({ conversationId: 'old', sessionId: 'sx', prompt: 'fix the parser', active: false })
const older = conversation({ conversationId: 'older', sessionId: 'sy', prompt: 'tidy the docs', active: false, ordinal: -1 })
const held = conversation({ conversationId: 'conv-a', sessionId: 'sa', ordinal: 1 })

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

  it('asks before closing a session, warning about one mid-turn', async () => {
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'waiting', conversationId: 'conv-a' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close session Claude' }))
    expect(await screen.findByText(/^Its agent stops\. The conversation stays/)).toBeTruthy()
    expect(server.called(CLOSE)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(1))

    cleanup()
    useUiStore.setState({ layouts: {} })
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'running' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close session Claude' }))
    expect(await screen.findByText('Its agent stops mid-turn.')).toBeTruthy()
    expect(server.called(CLOSE)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(2))
  })

  it('keeps an exited session\'s pane, to resume or close it, by its bar or its tab without asking', async () => {
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', exited: true })] })
    expect(screen.getByText('Claude exited.')).toBeTruthy()
    expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(server.called(RESUME)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Close session Claude' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a workspace with no session what it can start, its history included', async () => {
    show({ conversations: [closed] })
    expect(screen.getByText('No agent is running here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Earlier conversations' }))
    expect(await screen.findByText('the parser is fixed')).toBeTruthy()

    // New session opens the create form aimed at this workspace.
    cleanup()
    useUiStore.setState({ layouts: {} })
    show({})
    expect(screen.queryByRole('button', { name: 'Earlier conversations' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(useUiStore.getState().newWorkspace).toMatchObject({ projectId: 'proj', inWorkspace: 's1' })
  })

  it('reads closed sessions\' conversations beside an open one, and resumes one into a focused pane', async () => {
    const open = sessionEntry({ sessionId: 'sa', conversationId: 'conv-a' })
    const view = show({ sessions: [open], conversations: [older, closed, held] })
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText('the parser is fixed')).toBeTruthy()
    expect(useUiStore.getState().activeTabs.s1).toBe('history')

    // A refusal shows whole under the conversation it was for, and only there.
    const refusal = 'cannot launch: the history of old is gone from the checkout'
    server.route(OPEN, serverError('CONFLICT', refusal, 409))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(await screen.findByText(refusal)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'tidy the docs' }))
    expect(await screen.findByText('the docs are tidy')).toBeTruthy()
    expect(screen.queryByText(refusal)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'fix the parser' }))
    expect(await screen.findByText(refusal)).toBeTruthy()

    server.route(OPEN, { sessionId: 'sn', workspaceId: 's1' })
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(server.called(OPEN)).toHaveLength(2))
    expect(server.called(OPEN).map((c) => c.body)).toEqual([{ resume: 'old' }, { resume: 'old' }])

    // Its new session holds it now, so it leaves the history and its pane
    // takes focus as soon as the snapshot lists it.
    const resumed = sessionEntry({ sessionId: 'sn', conversationId: 'old', ordinal: 1 })
    show({ sessions: [open, resumed], conversations: [older, { ...closed, active: true, sessionId: 'sn' }, held] }, view)
    await waitFor(() => expect(useUiStore.getState().activeTabs.s1).toBe('session:sn'))
    expect(screen.queryByRole('button', { name: 'fix the parser' })).toBeNull()
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
