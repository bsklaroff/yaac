import type { JSX } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ACP_PAGE_SPAN, type AcpEvent, type AcpServerMessage } from '@yaac/shared/acp'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { useUiStore } from '#lib/store'
import {
  agentEvent as said, conversation, FakeSocket, mockFetch, renderWithClient, serverError, sessionEntry, testQueryClient,
  userEvent as asked, type FetchMock,
} from './harness'

/**
 * The read-only pane's conversation view. The server is answered at
 * `fetch` and rendering is real, so the tests check what the reader sees:
 * the conversation, a picker when there are several, and the founding prompt
 * when there is nothing to read. Every step is shown unless a case turns
 * condensed on; folding the main conversation is covered with the title-bar
 * toggles in read-only-workspace.test.tsx.
 */

const TRANSCRIPT = 'GET /api/workspace/w1/conversations/c1/transcript'

const session: typeof conversation = (over) => conversation({ mode: 'tui', ...over })

/** A live pane's one conversation, held by a session in `status`. */
const holding = (status: 'running' | 'waiting', asking?: true): Partial<Parameters<typeof ReadOnlyTranscript>[0]> => ({
  live: true,
  conversations: [session({ sessionId: 's1' })],
  liveSessions: [sessionEntry({ sessionId: 's1', conversationId: 'c1', mode: 'tui', status, ...(asking ? { asking } : {}) })],
})

let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ chatCondensed: false })
  server = mockFetch({ [TRANSCRIPT]: { page: 0, events: [asked(0, 'what changed?'), said(1, 'the router')] } })
})

/** Answer conversation c1's transcript with these events. */
const transcript = (events: AcpEvent[]): void => server.route(TRANSCRIPT, { page: 0, events })

function renderPane(props: Partial<Parameters<typeof ReadOnlyTranscript>[0]> = {}): void {
  renderWithClient(
    <ReadOnlyTranscript
      workspaceId="w1"
      conversations={[session()]}
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

  it('shows message and tool result images, loading one stored apart from the record from the server', async () => {
    const hash = 'ab'.repeat(32)
    const shot = 'cd'.repeat(32)
    transcript([
      {
        type: 'user',
        seq: 0,
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'image', mimeType: 'image/png', hash },
        ],
      },
      {
        type: 'tool',
        seq: 1,
        call: {
          toolCallId: 't1',
          title: 'browser_take_screenshot',
          kind: 'other',
          status: 'completed',
          content: [{ type: 'text', text: 'Took the screenshot' }, { type: 'image', mimeType: 'image/png', hash: shot }],
        },
      },
    ])
    renderPane()
    await screen.findByText('look')
    // A tool's images show while its row is closed, and are drawn rather
    // than named once it opens.
    const srcs = (): Array<string | null> => [...document.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(srcs()).toEqual([
      'data:image/png;base64,iVBORw0KGgo=',
      `/api/workspace/w1/acp-images/${hash}`,
      `/api/workspace/w1/acp-images/${shot}`,
    ])
    fireEvent.click(screen.getByText('browser_take_screenshot'))
    expect(screen.getByText('Took the screenshot')).toBeTruthy()
    expect(screen.queryByText(/\[image\/png image\]/)).toBeNull()
    expect(srcs()).toHaveLength(3)
  })

  it('offers the workspace\'s conversations in restore order and switches between them', async () => {
    // `/clear` starts a second conversation in the same workspace; both are
    // readable, and the one the workspace was last in opens first.
    transcript([said(0, 'the first answer')])
    server.route(TRANSCRIPT.replace('c1', 'c2'), { page: 0, events: [said(0, 'the second answer')] })
    renderPane({
      conversations: [
        session({ conversationId: 'c1', ordinal: 0, active: false, prompt: 'first ask' }),
        session({ conversationId: 'c2', ordinal: 1, active: true, prompt: 'second ask' }),
      ],
    })

    expect(await screen.findByText('the second answer')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'first ask' }))
    expect(await screen.findByText('the first answer')).toBeTruthy()
  })

  it('reads a tui conversation of any tool', async () => {
    // The server translates each tool's own history, so none is skipped.
    renderPane({ conversations: [session({ tool: 'opencode' })] })
    expect(await screen.findByText('the router')).toBeTruthy()
  })

  it('falls back to the founding ask when there is no conversation to read', async () => {
    // A workspace stopped a moment ago has none listed yet; a conversation
    // the server has no record of answers 404.
    renderPane({ conversations: [], prompt: 'what changed?' })
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
    // Condensed shows the cards but folds the subagent's steps, as in the
    // live pane.
    useUiStore.setState({ chatCondensed: true })
    transcript([
      { type: 'subagent', seq: 0, subagent: { id: 's1', name: 'Explore', task: 'find the router', state: 'completed' } },
      {
        type: 'tool',
        seq: 3,
        thread: 's1',
        call: { toolCallId: 't8', title: 'grep router', kind: 'search', status: 'completed' },
      },
      said(4, 'in src/router.ts', 's1'),
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
    expect(screen.getByText('in src/router.ts')).toBeTruthy()
    expect(screen.queryByText('grep router')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
    expect(screen.getByText('grep router')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    fireEvent.click(screen.getByRole('button', { name: /dev server/ }))
    expect(screen.getByText('npm run dev', { selector: 'pre' })).toBeTruthy()
    expect(screen.queryByText(/no messages/)).toBeNull()
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

  describe('a conversation in pages', () => {
    /**
     * jsdom lays nothing out, so the scroller gets a geometry: each rendered
     * row is 1000px tall in a 500px window, and the scroll position is kept.
     */
    const at = new WeakMap<Element, number>()
    const stubbed = ['scrollHeight', 'clientHeight', 'scrollTop'] as const
    beforeEach(() => {
      const rows = (el: Element): number => el.querySelectorAll('[data-seq]').length * 1000
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return rows(this) } })
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 })
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: Element) { return at.get(this) ?? 0 },
        set(this: Element, v: number) { at.set(this, Math.max(0, Math.min(v, rows(this) - 500))) },
      })
    })
    afterEach(() => {
      for (const key of stubbed) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    })

    const compacted = (seq: number, id: string): AcpEvent => ({
      type: 'compaction', seq, compaction: { id, status: 'completed', trigger: 'auto', tokensBefore: 180_000, tokensAfter: 12_000, summary: `kept by ${id}` },
    })
    const PAGES: AcpEvent[][] = [
      [asked(0, 'first ask'), said(1, 'first answer')],
      [compacted(ACP_PAGE_SPAN, 'c1'), said(ACP_PAGE_SPAN + 1, 'second answer')],
      [compacted(2 * ACP_PAGE_SPAN, 'c2'), said(2 * ACP_PAGE_SPAN + 1, 'third answer')],
    ]
    const scroller = (): HTMLElement => screen.getByText('third answer', { exact: false }).closest('.overflow-y-auto')!
    const scrollTo = (el: HTMLElement, top: number): void => {
      el.scrollTop = top
      fireEvent.scroll(el)
    }

    it('opens at the end, reads earlier pages scrolling up, and jumps to either end', async () => {
      server.route(TRANSCRIPT, (c: { query: URLSearchParams }) => {
        const page = c.query.get('page')
        return page === null ? { page: 2, events: PAGES[2] } : { page: Number(page), events: PAGES[Number(page)] }
      })
      renderPane()
      expect(await screen.findByText('third answer')).toBeTruthy()
      const el = scroller()
      // Only the last page, at its end, with the compaction that opens it.
      expect(screen.queryByText('second answer')).toBeNull()
      expect(el.scrollTop).toBe(1500)
      expect(screen.getByText('Conversation compacted automatically · 180k → 12k tokens')).toBeTruthy()

      // Near the top, the page before loads above, and the reader stays put.
      scrollTo(el, 100)
      expect(await screen.findByText('second answer')).toBeTruthy()
      expect(el.scrollTop).toBe(2100)
      expect(screen.queryByText('first answer')).toBeNull()

      // The start shows the first page alone; scrolling down reads on.
      fireEvent.click(screen.getByRole('button', { name: 'Jump to the start' }))
      expect(await screen.findByText('first answer')).toBeTruthy()
      await waitFor(() => expect(screen.queryByText('third answer')).toBeNull())
      expect(el.scrollTop).toBe(0)
      scrollTo(el, 1500)
      expect(await screen.findByText('second answer')).toBeTruthy()

      // And the latest page is one jump away.
      fireEvent.click(screen.getByRole('button', { name: 'Jump to the latest' }))
      expect(await screen.findByText('third answer')).toBeTruthy()
      // Each earlier page was read once: going back down reuses page 1.
      expect(server.called(TRANSCRIPT).map((c) => c.query.get('page'))).toEqual([null, '1', '0'])

      // A compaction opens to the summary the agent kept.
      fireEvent.click(screen.getByText('Conversation compacted automatically · 180k → 12k tokens'))
      expect(screen.getByText('kept by c2')).toBeTruthy()
    })
  })

  describe('a running workspace\'s conversation', () => {
    beforeEach(() => {
      FakeSocket.instances = []
      vi.stubGlobal('WebSocket', FakeSocket)
    })
    afterEach(() => vi.unstubAllGlobals())

    const greet = (events: AcpEvent[], over: Partial<Extract<AcpServerMessage, { type: 'hello' }>> = {}): void => {
      const sock = FakeSocket.latest()
      act(() => {
        sock.open()
        sock.deliver({ type: 'hello', conversationId: 'c1', busy: false, queued: [], page: 0, events, ...over })
      })
    }
    const pending = { type: 'tool', seq: 2, call: { toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'pending' } } as const

    it('follows it as it happens, with what runs shown running while the agent works', async () => {
      // A tui conversation, followed through its tool's history: the
      // stream reports no turns, so the snapshot's status says it works.
      renderPane(holding('running'))
      expect(await screen.findByText('the router')).toBeTruthy()
      expect(FakeSocket.latest().url).toMatch(/\/api\/acp\/observe\?.*session=c1/)
      greet([asked(0, 'what changed?'), said(1, 'the router'), pending], { history: true })
      expect(await screen.findByLabelText('running')).toBeTruthy()
      expect(screen.queryByText('interrupted')).toBeNull()
      expect(screen.getByText('working')).toBeTruthy()

      act(() => FakeSocket.latest().deliver({ type: 'event', event: said(3, 'all green') }))
      expect(await screen.findByText('all green')).toBeTruthy()
      // The stream carries it from its first page; the route is read once.
      expect(server.called(TRANSCRIPT)).toHaveLength(1)
    })

    it('shows an open ask as waiting on the teammate, with nothing to answer it', async () => {
      renderPane({ ...holding('waiting', true), owner: 'Ada' })
      greet([asked(0, 'clean up'), {
        type: 'permission-request', seq: 1, requestId: '7',
        toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
      }], { busy: true })
      expect(await screen.findByText('Waiting for Ada\'s answer')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
      expect(FakeSocket.latest().sent).toEqual([])
    })

    it('asks for a subagent\'s transcript each time it is opened, since the server follows only the last asked for', async () => {
      renderPane(holding('running'))
      greet([
        { type: 'subagent', seq: 0, subagent: { id: 'sa', name: 'Explore', task: 'find the router', state: 'running' } },
        { type: 'subagent', seq: 1, subagent: { id: 'sb', name: 'Review', task: 'check the diff', state: 'running' } },
      ], { history: true })
      const sock = FakeSocket.latest()
      const asked = (): string[] => sock.sent.map((d) => JSON.parse(d) as { type: string; subagentId?: string })
        .flatMap((m) => (m.type === 'subagent-transcript' && m.subagentId !== undefined ? [m.subagentId] : []))
      const visit = async (name: string, id: string): Promise<void> => {
        fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(name) }))[0])
        await waitFor(() => expect(asked().at(-1)).toBe(id))
        act(() => sock.deliver({ type: 'subagent-transcript', subagentId: id, events: [] }))
        fireEvent.click(screen.getByRole('button', { name: /Back/ }))
      }
      await visit('Explore', 'sa')
      await visit('Review', 'sb')
      await visit('Explore', 'sa')
      // Once per open: an answer does not ask again.
      expect(asked()).toEqual(['sa', 'sb', 'sa'])
    })

    it('marks each conversation\'s tab with the status of the session holding it', async () => {
      renderPane({
        live: true,
        owner: 'Ada',
        conversations: [
          session({ sessionId: 'sa', prompt: 'first' }),
          session({ conversationId: 'c2', sessionId: 'sb', ordinal: 1, prompt: 'second' }),
          // One its session held before a `/clear` has no status of its own.
          session({ conversationId: 'c0', sessionId: 'sb', ordinal: 2, active: false, prompt: 'older' }),
        ],
        liveSessions: [
          sessionEntry({ sessionId: 'sa', conversationId: 'c1', status: 'running' }),
          sessionEntry({ sessionId: 'sb', conversationId: 'c2', status: 'waiting', asking: true }),
        ],
      })
      expect(await screen.findByLabelText('Waiting for Ada\'s answer')).toBeTruthy()
      expect(screen.getByRole('button', { name: /first/ }).querySelector('.braille-spinner')).toBeTruthy()
      expect(screen.getByRole('button', { name: /older/ }).querySelector('span[aria-label], .braille-spinner')).toBeNull()
    })
  })

  it('never serves a page read while it ran as the stopped record', async () => {
    // A teammate's running workspace is read once before its stream takes
    // over; once it stops, the stopped view must fetch its final record
    // rather than reuse that read.
    const client = testQueryClient()
    const pane = (live: boolean): JSX.Element => <ReadOnlyTranscript workspaceId="w1" conversations={[session()]} live={live} />
    const view = renderWithClient(pane(true), client)
    expect(await screen.findByText('the router')).toBeTruthy()
    transcript([asked(0, 'what changed?'), said(1, 'the router'), said(2, 'and the final turn')])
    view.rerender(<QueryClientProvider client={client}>{pane(false)}</QueryClientProvider>)
    expect(await screen.findByText(/and the final turn/)).toBeTruthy()
    expect(server.called(TRANSCRIPT)).toHaveLength(2)
  })
})
