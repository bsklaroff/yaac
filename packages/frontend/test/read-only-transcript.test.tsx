// @vitest-environment jsdom
import type { JSX } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, fireEvent, cleanup } from '@testing-library/react'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, testQueryClient, type FetchMock } from './harness'

/**
 * The read-only pane's conversation view. The server is answered at
 * `fetch` and rendering is real, so the tests check what the reader sees:
 * the conversation, a picker when there are several, and the founding prompt
 * when there is nothing to read. Every step is shown unless a case turns
 * condensed on; folding the main conversation is covered with the title-bar
 * toggles in read-only-workspace.test.tsx.
 */

const TRANSCRIPT = 'GET /api/workspace/w1/agent-sessions/c1/transcript'

const session = (over: Partial<AgentSessionEntry> = {}): AgentSessionEntry => ({
  agentSessionId: 'c1',
  tool: 'claude',
  mode: 'tui',
  ordinal: 0,
  active: true,
  ...over,
})

const said = (seq: number, text: string): AcpEvent =>
  ({ type: 'agent', seq, content: [{ type: 'text', text }] })

const asked = (seq: number, text: string): AcpEvent =>
  ({ type: 'user', seq, content: [{ type: 'text', text }] })

let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ chatCondensed: false })
  server = mockFetch({ [TRANSCRIPT]: { events: [asked(0, 'what changed?'), said(1, 'the router')] } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Answer conversation c1's transcript with these events. */
const transcript = (events: AcpEvent[]): void => server.route(TRANSCRIPT, { events })

function renderPane(props: Partial<Parameters<typeof ReadOnlyTranscript>[0]> = {}): void {
  renderWithClient(
    <ReadOnlyTranscript
      workspaceId="w1"
      sessions={[session()]}
      prompt="what changed?"
      {...props}
    />,
  )
}

describe('ReadOnlyTranscript', () => {
  it('renders what was actually said, not just the founding ask', async () => {
    renderPane()
    expect(await screen.findByText('the router')).toBeTruthy()
    expect(server.called(TRANSCRIPT)).toHaveLength(1)
  })

  it('offers the workspace\'s conversations in restore order and switches between them', async () => {
    // `/clear` starts a second conversation in the same workspace; both are
    // readable, and the one the workspace was last in opens first.
    transcript([said(0, 'the first answer')])
    server.route(TRANSCRIPT.replace('c1', 'c2'), { events: [said(0, 'the second answer')] })
    renderPane({
      sessions: [
        session({ agentSessionId: 'c1', ordinal: 0, active: false, prompt: 'first ask' }),
        session({ agentSessionId: 'c2', ordinal: 1, active: true, prompt: 'second ask' }),
      ],
    })

    expect(await screen.findByText('the second answer')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'first ask' }))
    expect(await screen.findByText('the first answer')).toBeTruthy()
  })

  it('reads a tui conversation of any tool', async () => {
    // The server translates each tool's own history, so none is skipped.
    renderPane({ sessions: [session({ tool: 'opencode' })] })
    expect(await screen.findByText('the router')).toBeTruthy()
  })

  it('falls back to the founding ask when there is no conversation to read', async () => {
    // A workspace stopped a moment ago has none listed yet; a conversation
    // the server has no record of answers 404.
    renderPane({ sessions: [], prompt: 'what changed?' })
    expect(screen.getByText('what changed?')).toBeTruthy()
    cleanup()

    server.route(TRANSCRIPT, serverError('NOT_FOUND', 'gone', 404))
    renderPane({ prompt: 'port it' })
    expect(await screen.findByText('port it')).toBeTruthy()
    cleanup()

    // A history the server found nothing in, such as an opencode checkpoint
    // not yet exported, shows the prompt rather than "no messages".
    transcript([])
    renderPane({ prompt: 'port it again' })
    expect(await screen.findByText('port it again')).toBeTruthy()
    expect(screen.queryByText(/no messages/)).toBeNull()
  })

  it('passes on the server\'s reason when it refuses to show a conversation', async () => {
    // A too-large conversation is refused with a specific reason; a generic
    // "could not be read" would give the user nothing to act on.
    server.route(TRANSCRIPT, serverError(
      'TOO_LARGE', 'this conversation is 300 MB, past the 64 MB a transcript can be shown at', 413,
    ))
    renderPane()

    expect(await screen.findByText(/past the 64 MB/)).toBeTruthy()
  })

  it('says so when the conversation is empty and there is no prompt to show instead', async () => {
    transcript([])
    renderPane({ prompt: undefined })
    expect(await screen.findByText(/no messages/i)).toBeTruthy()
  })

  it('shows a call the record left unfinished as interrupted, not running', async () => {
    // A workspace stopped mid-command leaves no turn end in the record.
    transcript([
      { type: 'tool', seq: 0, call: { toolCallId: 't1', title: 'sleep 50', kind: 'execute', status: 'pending' } },
    ])
    renderPane()
    expect(await screen.findByText('interrupted')).toBeTruthy()
    expect(screen.queryByLabelText('running')).toBeNull()
  })

  it('shows an unanswered permission ask as one, without buttons that cannot work', async () => {
    // A workspace can be stopped while its agent waits on a question. Nothing
    // can answer it now, so the pane says so instead of showing an Allow
    // button that does nothing.
    transcript([
      {
        type: 'permission-request',
        seq: 0,
        requestId: '7',
        toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
      },
    ])
    renderPane()

    expect(await screen.findByText(/never answered/i)).toBeTruthy()
    // The tool call the question was about is still shown.
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('opens a subagent with what it was asked and every step, and a task with the command that started it', async () => {
    // Condensed folds the main conversation only, as in the live pane.
    useUiStore.setState({ chatCondensed: true })
    transcript([
      { type: 'subagent', seq: 0, subagent: { id: 's1', name: 'Explore', task: 'find the router', state: 'completed' } },
      {
        type: 'tool',
        seq: 3,
        thread: 's1',
        call: { toolCallId: 't8', title: 'grep router', kind: 'search', status: 'completed' },
      },
      { type: 'agent', seq: 4, thread: 's1', content: [{ type: 'text', text: 'in src/router.ts' }] },
      {
        type: 'tool',
        seq: 1,
        call: { toolCallId: 't9', title: 'npm run dev', shell: true, kind: 'execute', status: 'completed' },
      },
      {
        type: 'task',
        seq: 2,
        task: { id: 'b1', name: 'dev server', kind: 'shell', description: '', state: 'completed', toolCallId: 't9' },
      },
    ])
    renderPane()

    fireEvent.click(await screen.findByRole('button', { name: '1 tool call, 1 subagent, 1 task' }))
    fireEvent.click(screen.getByRole('button', { name: /Explore/ }))
    expect(screen.getByText('find the router')).toBeTruthy()
    expect(screen.getByText('in src/router.ts')).toBeTruthy()
    expect(screen.getByText('grep router')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    fireEvent.click(screen.getByRole('button', { name: /dev server/ }))
    expect(screen.getByText('npm run dev', { selector: 'pre' })).toBeTruthy()
  })

  it('shows a decided ask as the decision, the same as a live pane would', async () => {
    transcript([
      {
        type: 'permission-request',
        seq: 0,
        requestId: '7',
        toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
      },
      { type: 'permission-resolved', seq: 1, requestId: '7', outcome: 'selected', optionId: 'allow' },
    ])
    renderPane()

    expect(await screen.findByText(/Allow Once/)).toBeTruthy()
    expect(screen.queryByText(/never answered/i)).toBeNull()
  })

  it('never serves a live poll as the stopped record', async () => {
    // A teammate's running workspace is polled; once it stops, the stopped
    // view must fetch its final record rather than reuse the last poll.
    const client = testQueryClient()
    const pane = (live: boolean): JSX.Element => <ReadOnlyTranscript workspaceId="w1" sessions={[session()]} live={live} />
    const view = renderWithClient(pane(true), client)
    expect(await screen.findByText('the router')).toBeTruthy()
    transcript([asked(0, 'what changed?'), said(1, 'the router'), said(2, 'and the final turn')])
    view.rerender(<QueryClientProvider client={client}>{pane(false)}</QueryClientProvider>)
    expect(await screen.findByText(/and the final turn/)).toBeTruthy()
    expect(server.called(TRANSCRIPT)).toHaveLength(2)
  })
})
