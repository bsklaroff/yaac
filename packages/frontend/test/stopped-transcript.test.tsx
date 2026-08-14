// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'
import type * as transcriptApiModule from '#lib/transcriptApi'

/**
 * A stopped worktree's conversation, in the pane that used to show only the
 * question that started it.
 *
 * The fetch is mocked at the api module and the rendering is real, because the
 * thing worth holding here is what a reader is offered: the conversation when
 * there is one, which conversation when there are several, and the founding
 * ask when the tool left nothing readable behind.
 */

vi.mock('#lib/transcriptApi', async (importOriginal) => ({
  // The viewability predicate is a pure decision about a row, and the pane
  // branches on it — mocking it would mock the behavior under test.
  ...await importOriginal<typeof transcriptApiModule>(),
  getSessionTranscript: vi.fn(),
}))

import { StoppedTranscript } from '#components/StoppedTranscript'
import { getSessionTranscript, TRANSCRIPT_UNAVAILABLE } from '#lib/transcriptApi'

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSessionTranscript).mockResolvedValue([asked(0, 'what changed?'), said(1, 'the router')])
})

afterEach(cleanup)

function renderPane(props: Partial<Parameters<typeof StoppedTranscript>[0]> = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <StoppedTranscript
        worktreeId="w1"
        sessions={[session()]}
        tool="claude"
        prompt="what changed?"
        {...props}
      />
    </QueryClientProvider>,
  )
}

describe('StoppedTranscript', () => {
  it('renders what was actually said, not just the founding ask', async () => {
    renderPane()
    expect(await screen.findByText('the router')).toBeTruthy()
    expect(getSessionTranscript).toHaveBeenCalledWith('w1', 'c1')
  })

  it('offers the worktree\'s conversations in restore order and switches between them', async () => {
    // `/clear` starts a second conversation in the same worktree; both are
    // readable, and the one the worktree was last in opens first.
    vi.mocked(getSessionTranscript).mockImplementation((_w, id) =>
      Promise.resolve([said(0, id === 'c1' ? 'the first answer' : 'the second answer')]))
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
    expect(screen.getByText(/keeps its history inside the worktree/)).toBeTruthy()
    await waitFor(() => expect(getSessionTranscript).not.toHaveBeenCalled())
  })

  it('does not blame the tool for a worktree whose conversations are not listed yet', () => {
    // The optimistic row of a worktree stopped a moment ago: its real
    // conversations are still in flight, so "this tool keeps no history"
    // would be both wrong and permanent-sounding.
    renderPane({ sessions: [], prompt: 'what changed?' })

    expect(screen.getByText('what changed?')).toBeTruthy()
    expect(screen.queryByText(/keeps its history inside the worktree/)).toBeNull()
  })

  it('falls back to the founding ask when the server cannot produce a transcript', async () => {
    // A 501 from a tool the server won't read, or a 404 from a server too old
    // to serve the route at all: either way the pane degrades to what it
    // always showed rather than to an error.
    vi.mocked(getSessionTranscript).mockResolvedValue(TRANSCRIPT_UNAVAILABLE)
    renderPane({ prompt: 'port it' })

    expect(await screen.findByText('port it')).toBeTruthy()
    // ...but it must not blame claude, whose history this install can read
    // perfectly well. Landing here for a viewable conversation means the
    // server is too old to serve the route, which resolves on its own.
    expect(screen.queryByText(/keeps its history inside the worktree/)).toBeNull()
  })

  it('passes on the server\'s reason when it refuses to show a conversation', async () => {
    // A conversation too large to answer with is refused by name; a generic
    // "could not be read" would leave the user with nothing to act on.
    vi.mocked(getSessionTranscript).mockRejectedValue(
      new ServerError('TOO_LARGE', 'this conversation is 300 MB, past the 64 MB a transcript can be shown at'),
    )
    renderPane()

    expect(await screen.findByText(/past the 64 MB/)).toBeTruthy()
  })

  it('says so when the conversation is empty rather than showing a blank pane', async () => {
    vi.mocked(getSessionTranscript).mockResolvedValue([])
    renderPane()
    expect(await screen.findByText(/no messages/i)).toBeTruthy()
  })

  it('shows an unanswered permission ask as one, without buttons that cannot work', async () => {
    // A worktree can be stopped while its agent sits blocked on a question, so
    // this is an ordinary thing to find in a transcript. There is no socket
    // behind it any more, and a live-looking Allow that silently does nothing
    // would be worse than saying plainly that the question outlived its
    // conversation.
    vi.mocked(getSessionTranscript).mockResolvedValue([
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
    // The call is still shown — it is what the question was about.
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('shows a decided ask as the decision, the same as a live pane would', async () => {
    vi.mocked(getSessionTranscript).mockResolvedValue([
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
