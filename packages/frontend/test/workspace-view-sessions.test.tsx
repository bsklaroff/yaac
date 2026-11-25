import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, cleanup, waitFor, fireEvent, act, type RenderResult } from '@testing-library/react'
import type { WorkspaceListEntry } from '@yaac/shared/types'

// No xterm, no sockets: the terminal, chat and log panes are stubs naming
// what they were given.
vi.mock('#components/WorkspaceTerminal', () => ({
  WorkspaceTerminal: ({ target, focusKey }: { target: string; focusKey?: number }) => (
    <div data-testid="terminal" data-focus-key={focusKey}>{target}</div>
  ),
}))
vi.mock('#components/WorkspaceChat', () => ({
  WorkspaceChat: ({ conversationId, focusKey }: { conversationId: string; focusKey?: number }) => (
    <div data-testid="chat" data-focus-key={focusKey}>{conversationId}</div>
  ),
}))
vi.mock('#components/StepLog', () => ({
  StepLog: ({ life, file }: { life: string; file: string }) => <div data-testid="log">{`${life}/${file}`}</div>,
}))

import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import {
  agentEvent, conversation, mockFetch, renderWithClient, serverError, serverSnapshot, sessionEntry, TEST_USER_ID,
  testQueryClient, workspaceEntry, type FetchMock,
} from './harness'
import { resizeAll } from './setup'

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
  vi.restoreAllMocks()
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
    expect(screen.getByRole('button', { name: 'Close agent Claude' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close agent Codex' })).toBeTruthy()
  })

  // Its terminal mounts at once, so it is attached by the time it shows,
  // but is not focused until then.
  it('draws a terminal session starting, with its opening message, until its agent starts on it', () => {
    const starting = sessionEntry({ sessionId: 'sa', mode: 'tui', window: 'claude-sa', prompt: 'port the parser', opening: true })
    const view = show({ sessions: [starting] })
    expect(screen.getByText('port the parser')).toBeTruthy()
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()
    expect(screen.getByTestId('terminal').textContent).toBe('session:claude-sa')
    expect(screen.getByTestId('terminal').dataset.focusKey).toBeUndefined()

    const { opening: _, ...started } = starting
    show({ sessions: [{ ...started, status: 'running' }] }, view)
    expect(screen.queryByText('port the parser')).toBeNull()
    expect(screen.queryByText('Starting Claude Code')).toBeNull()
    expect(screen.getByTestId('terminal').dataset.focusKey).toBeDefined()
  })

  it('asks before closing a session, warning about one mid-turn', async () => {
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'waiting', conversationId: 'conv-a' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close agent Claude' }))
    expect(await screen.findByText(/^Its agent stops\. The conversation stays/)).toBeTruthy()
    expect(server.called(CLOSE)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(1))

    cleanup()
    useUiStore.setState({ layouts: {} })
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'tui', status: 'running' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Close agent Claude' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Close agent Claude' }))
    await waitFor(() => expect(server.called(CLOSE)).toHaveLength(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  /*
   * A chat session's log is offered only once its agent exited, from the
   * bar under it, whether or not a chat ever opened. Back returns to what
   * the log covered, and a resume returns to the chat.
   */
  it('offers a chat session\'s agent log from the exited bar, and only once the agent exited', () => {
    const LIFE = '2026-11-03T01:00:00.000Z'
    const starting = sessionEntry({ sessionId: 'sa', window: 'claude-sa' })
    const view = show({ life: LIFE, sessions: [starting] })
    expect(screen.getByText('Starting Claude Code')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show log' })).toBeNull()

    show({ life: LIFE, sessions: [{ ...starting, exited: true }] }, view)
    expect(screen.getByText('Claude Code exited before the chat opened.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show log' }))
    expect(screen.getByTestId('log').textContent).toBe('2026-11-03T01-00-00.000Z/claude-sa.log')
    expect(screen.queryByRole('button', { name: 'Show log' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByTestId('log')).toBeNull()
    expect(screen.getByText('Claude Code exited before the chat opened.')).toBeTruthy()

    const running = { ...starting, conversationId: 'conv-a' }
    show({ life: LIFE, sessions: [running] }, view)
    expect(screen.getByTestId('chat').textContent).toBe('conv-a')
    expect(screen.queryByRole('button', { name: 'Show log' })).toBeNull()

    show({ life: LIFE, sessions: [{ ...running, exited: true }] }, view)
    fireEvent.click(screen.getByRole('button', { name: 'Show log' }))
    expect(screen.getByTestId('log')).toBeTruthy()
    show({ life: LIFE, sessions: [running] }, view)
    expect(screen.queryByTestId('log')).toBeNull()
  })

  it('shows a workspace with no session what it can start, its history included', async () => {
    show({ conversations: [closed] })
    expect(screen.getByText('No agent is running here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 stopped conversation' }))
    expect(await screen.findByText('the parser is fixed')).toBeTruthy()

    // New agent opens the create form aimed at this workspace.
    cleanup()
    useUiStore.setState({ layouts: {} })
    show({})
    expect(screen.queryByRole('button', { name: /stopped conversation/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(useUiStore.getState().newWorkspace).toMatchObject({ projectId: 'proj', inWorkspace: 's1' })
  })

  it('reads closed sessions\' conversations beside an open one, and resumes one into a focused pane', async () => {
    const open = sessionEntry({ sessionId: 'sa', conversationId: 'conv-a' })
    const view = show({ sessions: [open], conversations: [older, closed, held] })
    fireEvent.click(screen.getByRole('button', { name: 'More pane actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '2 stopped conversations' }))
    expect(await screen.findByText('the parser is fixed')).toBeTruthy()
    expect(useUiStore.getState().activeTabs.s1).toBe('history')

    // A refusal shows whole under the conversation it was for, and only there.
    const refusal = 'cannot launch: the history of old is gone from the checkout'
    server.route(OPEN, serverError('CONFLICT', refusal, 409))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(await screen.findByText(refusal)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'tidy the docs' }))
    expect(await screen.findByText('the docs are tidy')).toBeTruthy()
    expect(screen.queryByText(refusal)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'fix the parser' }))
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

  it('in tiles mode, outlines the focused column, sends focus with the pane shortcuts, and not on a click', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    const second = conversation({ conversationId: 'conv-b', sessionId: 'sb', ordinal: 2 })
    useUiStore.setState({
      viewMode: 'tiles',
      layouts: { s1: [{ tabs: ['session:sa'], active: 'session:sa' }, { tabs: ['session:sb'], active: 'session:sb' }] },
      activeTabs: { s1: 'session:sa' },
    })
    const view = show({
      sessions: [
        sessionEntry({ sessionId: 'sa', mode: 'acp', conversationId: 'conv-a' }),
        sessionEntry({ sessionId: 'sb', mode: 'acp', conversationId: 'conv-b', ordinal: 1 }),
      ],
      conversations: [held, second],
    })
    act(resizeAll)
    const columns = [...view.container.querySelectorAll<HTMLElement>('section')]
    const outline = (): HTMLElement | null => view.container.querySelector('.border-accent-outline')
    const focusedChat = (): string | undefined =>
      screen.getAllByTestId('chat').find((c) => c.dataset.focusKey !== undefined)?.textContent ?? undefined
    expect(columns).toHaveLength(2)
    expect(outline()?.style.left).toBe(columns[0].style.left)
    expect(focusedChat()).toBe('conv-a')

    fireEvent.keyDown(window, { code: 'KeyL', key: 'l', altKey: true })
    await waitFor(() => expect(focusedChat()).toBe('conv-b'))
    expect(outline()?.style.left).toBe(columns[1].style.left)

    fireEvent.keyDown(window, { code: 'KeyH', key: 'h', altKey: true })
    await waitFor(() => expect(focusedChat()).toBe('conv-a'))
    expect(outline()?.style.left).toBe(columns[0].style.left)

    // A press on the other pane's transcript, which focuses nothing, makes
    // it the focused pane. Focus is not sent to its box, which would drop
    // the selection the press starts, nor left with the pane it went to.
    fireEvent.pointerDown(screen.getByText('conv-b'))
    await waitFor(() => expect(outline()?.style.left).toBe(columns[1].style.left))
    expect(focusedChat()).toBeUndefined()
    fireEvent.keyDown(window, { code: 'KeyH', key: 'h', altKey: true })
    await waitFor(() => expect(focusedChat()).toBe('conv-a'))
    expect(outline()?.style.left).toBe(columns[0].style.left)

    // Closing the pane focus went to sends it to the one left.
    fireEvent.keyDown(window, { code: 'KeyL', key: 'l', altKey: true })
    await waitFor(() => expect(focusedChat()).toBe('conv-b'))
    show({ sessions: [sessionEntry({ sessionId: 'sa', mode: 'acp', conversationId: 'conv-a' })], conversations: [held] }, view)
    await waitFor(() => expect(focusedChat()).toBe('conv-a'))
  })

  /** A tui agent's terminal takes the key only once the agent has started,
   *  by which time the user may be typing in another pane. */
  it('in tiles mode, sends no focus to a pane the user has moved out of', async () => {
    const tui = sessionEntry({ sessionId: 'sb', mode: 'tui', window: 'claude-sb', prompt: 'port the parser', opening: true, ordinal: 1 })
    const chat = sessionEntry({ sessionId: 'sa', mode: 'acp', conversationId: 'conv-a' })
    useUiStore.setState({
      viewMode: 'tiles',
      layouts: { s1: [{ tabs: ['session:sa'], active: 'session:sa' }, { tabs: ['session:sb'], active: 'session:sb' }] },
      activeTabs: { s1: 'session:sb' },
    })
    const view = show({ sessions: [chat, tui], conversations: [held] })
    fireEvent.focusIn(screen.getByTestId('chat'))
    const { opening: _, ...started } = tui
    show({ sessions: [chat, started], conversations: [held] }, view)
    expect(screen.getByTestId('terminal').dataset.focusKey).toBeUndefined()
    expect(screen.getByTestId('chat').dataset.focusKey).toBeUndefined()
    expect(useUiStore.getState().activeTabs.s1).toBe('session:sa')

    // The next pane shortcut sends focus again.
    fireEvent.keyDown(window, { code: 'KeyL', key: 'l', altKey: true })
    await waitFor(() => expect(screen.getByTestId('terminal').dataset.focusKey).toBeDefined())
  })
})
