// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'
import { StoppedTranscript } from '#components/StoppedTranscript'
import { mockFetch, renderWithClient, serverError, type FetchMock } from './harness'

/**
 * The stopped-workspace pane's conversation view. The server is answered at
 * `fetch` and rendering is real, so the tests check what the reader sees:
 * the conversation, a picker when there are several, and the founding prompt
 * when the tool left nothing readable.
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
  server = mockFetch({ [TRANSCRIPT]: { events: [asked(0, 'what changed?'), said(1, 'the router')] } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Answer conversation c1's transcript with these events. */
const transcript = (events: AcpEvent[]): void => server.route(TRANSCRIPT, { events })

function renderPane(props: Partial<Parameters<typeof StoppedTranscript>[0]> = {}): void {
  renderWithClient(
    <StoppedTranscript
      workspaceId="w1"
      sessions={[session()]}
      tool="claude"
      prompt="what changed?"
      {...props}
    />,
  )
}

describe('StoppedTranscript', () => {
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

  it('shows the founding ask, and why, when the tool left no readable history', async () => {
    // opencode keeps its history in a sqlite database inside the container.
    // Nothing to fetch, so nothing is fetched.
    renderPane({ sessions: [session({ tool: 'opencode' })], tool: 'opencode', prompt: 'port it' })

    expect(screen.getByText('port it')).toBeTruthy()
    expect(screen.getByText(/keeps its history inside the workspace/)).toBeTruthy()
    await waitFor(() => expect(server.calls).toEqual([]))
  })

  it('does not blame the tool for a workspace whose conversations are not listed yet', () => {
    // A workspace stopped a moment ago: its conversations are still loading,
    // so "this tool keeps no history" would be wrong.
    renderPane({ sessions: [], prompt: 'what changed?' })

    expect(screen.getByText('what changed?')).toBeTruthy()
    expect(screen.queryByText(/keeps its history inside the workspace/)).toBeNull()
  })

  it('falls back to the founding ask when the server cannot produce a transcript', async () => {
    // A 501 (a tool the server won't read) or a 404 (a server too old for the
    // route) falls back to the founding prompt rather than an error.
    server.route(TRANSCRIPT, serverError('NOT_SUPPORTED', 'not readable', 501))
    renderPane({ prompt: 'port it' })

    expect(await screen.findByText('port it')).toBeTruthy()
    // ...but must not blame claude, whose history is readable. Landing here
    // for a viewable conversation means the server is too old for the route.
    expect(screen.queryByText(/keeps its history inside the workspace/)).toBeNull()
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

  it('says so when the conversation is empty rather than showing a blank pane', async () => {
    transcript([])
    renderPane()
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

  it('opens a subagent with what it was asked, and a task with the command that started it', async () => {
    transcript([
      { type: 'subagent', seq: 0, subagent: { id: 's1', name: 'Explore', task: 'find the router', state: 'completed' } },
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

    fireEvent.click(await screen.findByRole('button', { name: /Explore/ }))
    expect(screen.getByText('find the router')).toBeTruthy()
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
})
