import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type { JSX, ReactNode } from 'react'
import { ACP_PAGE_SPAN, type AcpClientMessage, type AcpDiff, type AcpEvent, type AcpEventInit, type AcpQueuedPrompt, type AcpToolCall } from '@yaac/shared/acp'
import type { PermissionMode, WorkspaceFiles } from '@yaac/shared/types'


/**
 * Draft persistence across unmounts (workspace stopped, tab closed, reload).
 * The tricky case is a draft that was sent but not yet echoed back, which
 * must not reappear in the box. The ACP hook is mocked; transport is covered
 * by use-acp-stream.test.tsx.
 */

const stream = {
  page: 0,
  life: undefined as string | undefined,
  events: [] as AcpEvent[],
  busy: false,
  queued: [] as AcpQueuedPrompt[],
  connected: true,
  refused: false,
  send: vi.fn((_msg: AcpClientMessage) => true),
  taskOutputs: {} as Record<string, { text?: string; error?: string }>,
  subagentTranscripts: {} as Record<string, { events?: AcpEventInit[]; error?: string }>,
  permissionModes: { available: [] } as { current?: PermissionMode; available: PermissionMode[] },
  efforts: { available: [] } as { current?: string; available: Array<{ value: string; name: string }> },
}

vi.mock('#lib/acp', () => ({ useAcpStream: () => stream }))
const snapshot = vi.fn((): { driver: string } | undefined => undefined)
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: () => snapshot() }))

import { WorkspaceChat } from '#components/WorkspaceChat'
import { chatDraftKey, flushTypedText, useUiStore } from '#lib/store'
import { IS_MAC } from '#lib/platform'
import { DISCONNECT_NOTICE_DELAY_MS } from '#lib/reconnect'
import { filesKey } from '#lib/useWorkspaceChanges'
import { agentEvent as agent, mockFetch, testQueryClient, userEvent as user } from './harness'
import { resizeAll } from './setup'

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox')
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

/** The text of each element `selector` matches. */
function textsOf(container: HTMLElement, selector: string): Array<string | null> {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent)
}

/* Most cases assert on every step, so they start from the full view. */
beforeEach(() => {
  useUiStore.setState({ chatCondensed: false })
})

/** The query client of the latest `show`, which holds the checkout's
 *  listing a test seeds. */
let client: QueryClient

/** The pane on screen, and the one the user is in unless `focused` is false. */
const pane = (workspaceId = 'w1', agentSessionId = 'acp-1', focused = true): JSX.Element =>
  <WorkspaceChat workspaceId={workspaceId} agentSessionId={agentSessionId} visible focused={focused} />

function show(workspaceId?: string, agentSessionId?: string, focused?: boolean): ReturnType<typeof render> {
  client = testQueryClient()
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return render(pane(workspaceId, agentSessionId, focused), { wrapper })
}

describe('WorkspaceChat drafts', () => {
  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.queued = []
    stream.connected = true
    stream.send.mockClear()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushTypedText()
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
    rerender(pane())
    await waitFor(() => expect(box().value).toBe(''))
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  /**
   * A draft restored on mount, as an earlier mount left it: `sent` was in
   * flight, and the box then held `draft`. The box clears only if it still
   * holds what was in flight and the replayed history or the server's queue
   * shows it arrived.
   */
  it.each<[string, { draft: string; sent?: string; events: AcpEvent[]; queued?: AcpQueuedPrompt[]; connected?: boolean }, string]>([
    // Sent, then navigated away before the echo; the history wins.
    ['drops one the conversation shows was delivered',
      { draft: 'already sent', sent: 'already sent', events: [user(0, 'already sent')] }, ''],
    ['drops one the server is holding in its queue',
      { draft: 'queued', sent: 'queued', events: [], queued: [{ id: 'q1', text: 'queued', images: 0 }] }, ''],
    // The socket dropped before the prompt got through.
    ['keeps one the conversation never received',
      { draft: 'never made it', sent: 'never made it', events: [user(0, 'an earlier message')] }, 'never made it'],
    // Why the `sent` marker exists: short replies repeat. "ok" was sent and
    // answered, then typed again and left unsent.
    ['keeps typed-but-unsent text that repeats what was already said',
      { draft: 'ok', events: [user(0, 'ok'), agent(1, 'done')] }, 'ok'],
    // The message arrived, but editing the box since made it new work.
    ['keeps an edited one even when the original send was delivered',
      { draft: 'ok, and one more thing', sent: 'ok', events: [user(0, 'ok')] }, 'ok, and one more thing'],
    // Nothing to compare against until the replay lands.
    ['keeps one while the pane is still connecting', { draft: 'unsent', events: [], connected: false }, 'unsent'],
  ])('%s', async (_, { draft, sent, events, queued = [], connected = true }, expected) => {
    const store = useUiStore.getState()
    store.setChatDraft('w1', 'acp-1', sent ?? draft)
    if (sent !== undefined) store.setChatSent('w1', 'acp-1', sent)
    store.setChatDraft('w1', 'acp-1', draft)
    Object.assign(stream, { events, queued, connected })
    show()
    await waitFor(() => expect(box().value).toBe(expected))
    expect(useUiStore.getState().chatDrafts[chatDraftKey('w1', 'acp-1')]).toEqual(expected === '' ? undefined : { text: expected })
  })
})

/**
 * A starting workspace's pane mounts before its conversation is live, so it
 * reads as connecting until its first attach; only a later drop, or the
 * server turning the pane away, that outlasts the notice delay is announced.
 */
describe('WorkspaceChat connection', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    stream.connected = true
    stream.refused = false
  })

  it('says connecting before the first attach, and disconnected only after a lasting drop', () => {
    vi.useFakeTimers()
    const notice = (): HTMLElement | null => screen.queryByText(/^Disconnected/)
    const set = (connected: boolean): void => {
      stream.connected = connected
      rerender(pane())
    }
    stream.connected = false
    const { rerender } = show()
    act(() => { vi.advanceTimersByTime(DISCONNECT_NOTICE_DELAY_MS) })
    expect([box().placeholder, notice()]).toEqual(['Connecting…', null])

    set(true)
    expect(box().placeholder).toBe('Message the agent…')

    // A drop that heals within the delay goes unannounced.
    set(false)
    act(() => { vi.advanceTimersByTime(DISCONNECT_NOTICE_DELAY_MS - 1) })
    expect(notice()).toBeNull()
    set(true)
    set(false)
    act(() => { vi.advanceTimersByTime(DISCONNECT_NOTICE_DELAY_MS - 1) })
    expect(notice()).toBeNull()

    act(() => { vi.advanceTimersByTime(1) })
    expect(box().placeholder).toBe('Reconnecting…')
    expect(notice()).not.toBeNull()
  })

  it('says disconnected once the server turns away a pane that never attached', () => {
    // Its conversation never came up within the server's hold, so the
    // workspace is not starting but missing it.
    vi.useFakeTimers()
    Object.assign(stream, { connected: false, refused: true })
    show()
    act(() => { vi.advanceTimersByTime(DISCONNECT_NOTICE_DELAY_MS) })
    expect(box().placeholder).toBe('Reconnecting…')
    expect(screen.queryByText(/^Disconnected/)).not.toBeNull()
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
    flushTypedText()
  })

  it('sends with Enter while the agent works, keeping Stop on offer', async () => {
    const { rerender } = show()
    // Grouped, so the row's spacing cannot push Stop away from Send.
    expect(screen.getByRole('button', { name: 'Stop turn' }).parentElement)
      .toBe(screen.getByRole('button', { name: 'Send' }).parentElement)
    type('use the staging config')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'use the staging config' })

    // A steered message echoes like any other, labelled as sent mid-turn,
    // and clears the box.
    expect(screen.queryByText('Sent mid-turn')).toBeNull()
    stream.events = [...stream.events, { type: 'user', seq: 1, content: [{ type: 'text', text: 'use the staging config' }], steered: true }]
    rerender(pane())
    await waitFor(() => expect(box().value).toBe(''))
    expect(screen.getAllByText('Sent mid-turn')).toHaveLength(1)
    expect(screen.getByText('use the staging config')).toBeTruthy()
  })

  it('clears the box once the message is queued, shows it, and lets it be dropped', async () => {
    const { rerender } = show()
    type('then write the docs')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Queued, not echoed: the box is free for the next message.
    stream.queued = [{ id: 'q1', text: 'then write the docs', images: 0 }]
    rerender(pane())
    await waitFor(() => expect(box().value).toBe(''))
    expect(screen.getByText('then write the docs')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    expect(stream.send).toHaveBeenLastCalledWith({ type: 'unqueue', id: 'q1' })
  })
})

// A chat create's prompt stands in for the conversation until the agent
// echoes it, so the create's spinner carries straight on into the chat.
describe('WorkspaceChat right after its create', () => {
  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    useUiStore.setState({ chatDrafts: {}, launches: { w1: { prompt: 'build it' } } })
  })

  afterEach(() => {
    stream.busy = false
    cleanup()
  })

  it('shows the prompt working until the echo, then the conversation itself', async () => {
    const { rerender } = show()
    expect(screen.getByText('build it')).toBeTruthy()
    expect(screen.getByText('working')).toBeTruthy()
    expect(screen.queryByText(/No messages yet/)).toBeNull()

    stream.events = [user(0, 'build it')]
    stream.busy = true
    rerender(pane())
    await waitFor(() => expect(useUiStore.getState().launches).toEqual({}))
    expect(screen.getAllByText('build it')).toHaveLength(1)
    expect(screen.getByText('working')).toBeTruthy()
  })

  it('leaves another workspace, and a failed start, to their own view', async () => {
    show('w2')
    expect(screen.getByText(/No messages yet/)).toBeTruthy()
    cleanup()

    stream.events = [{ type: 'error', seq: 0, message: 'the agent refused' }]
    show()
    expect(screen.getByText('the agent refused')).toBeTruthy()
    await waitFor(() => expect(useUiStore.getState().launches).toEqual({}))
    expect(screen.queryByText('build it')).toBeNull()
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

describe('WorkspaceChat permission mode', () => {
  afterEach(() => {
    cleanup()
    stream.permissionModes = { available: [] }
    snapshot.mockReturnValue(undefined)
  })

  it('shows the posture, switches it from the menu, and warns that containerless bypass acts as you', async () => {
    snapshot.mockReturnValue({ driver: 'containerless' })
    stream.send.mockClear()
    stream.permissionModes = { current: 'accept-edits', available: ['bypass', 'accept-edits', 'plan'] }
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode' }))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(within(items[0]).getByText('No sandbox — acts as you.')).toBeTruthy()
    fireEvent.click(items[2])
    expect(stream.send).toHaveBeenCalledWith({ type: 'permission-mode', mode: 'plan' })
  })

  it('shows a posture with nothing to switch to as plain text', () => {
    stream.permissionModes = { current: 'accept-edits', available: [] }
    show()
    expect(screen.getByText('Accept edits')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Permission mode' })).toBeNull()
  })
})

// docs/effort-levels.md. The levels and names are the adapter's own, for
// the conversation's current model.
describe('WorkspaceChat effort', () => {
  afterEach(() => {
    cleanup()
    stream.efforts = { available: [] }
  })

  it("shows the level by the agent's name for it and switches it from the menu", async () => {
    stream.send.mockClear()
    stream.efforts = {
      current: 'xhigh',
      available: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'Xhigh' }, { value: 'max', name: 'Max' }],
    }
    show()
    const trigger = screen.getByRole('button', { name: 'Effort' })
    expect(trigger.textContent).toContain('Xhigh effort')
    fireEvent.click(trigger)
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    fireEvent.click(items[2])
    expect(stream.send).toHaveBeenCalledWith({ type: 'effort', effort: 'max' })
  })

  it('shows nothing for an agent with no effort option', () => {
    show()
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })
})

describe('WorkspaceChat context meter', () => {
  afterEach(() => {
    cleanup()
    stream.events = []
  })

  it("shows the main conversation's latest context report, not a subagent's", () => {
    show()
    expect(screen.queryByRole('meter')).toBeNull()
    cleanup()

    stream.events = [
      { type: 'usage', seq: 0, used: 10_000, size: 200_000 },
      user(1, 'hi'),
      { type: 'usage', seq: 2, used: 160_000, size: 200_000 },
      { type: 'usage', seq: 3, thread: 'sub-1', used: 5_000, size: 200_000 },
    ]
    show()
    const meter = screen.getByRole('meter', { name: 'Context used' })
    expect(meter.textContent).toBe('160k / 200k')
    expect(meter.getAttribute('aria-valuetext')).toBe('Context: 160k of 200k tokens (80%)')
    expect(meter.className).toContain('text-warning')
    fireEvent.click(meter)
    expect(meter.textContent).toContain('Context: 160k of 200k tokens (80%)')
    fireEvent.click(meter)
    expect(meter.textContent).toBe('160k / 200k')
    cleanup()

    // The colour follows the rounded percentage, so 74.6% reads amber as 75%.
    stream.events = [{ type: 'usage', seq: 0, used: 149_200, size: 200_000 }]
    show()
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('75')
    expect(screen.getByRole('meter').className).toContain('text-warning')
  })
})

describe('WorkspaceChat condensed view', () => {
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
    useUiStore.setState({ chatDrafts: {}, chatCondensed: true })
  })


  it('folds all but the prompts, each turn’s last message and the live activity, and remembers the choice', () => {
    show()
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
    expect(localStorage.getItem('yaac.chatcondensed.v1')).toBe('0')
    expect(screen.getByText('grep b')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /tool call/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show key messages only' }))
    expect(localStorage.getItem('yaac.chatcondensed.v1')).toBe('1')
    expect(screen.getByRole('button', { name: '2 tool calls' })).toBeTruthy()
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
    show()
    for (const shown of [
      'answer A', 'message B', 'Permission needed', 'adapter crashed', 'turn ended: cancelled',
      'reply two', 'working on it', 'long bash', 'also do X', 't3',
    ]) expect(screen.getByText(shown)).toBeTruthy()
    for (const hidden of ['bg check', 't1', 't2']) expect(screen.queryByText(hidden)).toBeNull()
  })
})

describe('WorkspaceChat find', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Range.prototype.getBoundingClientRect = () => new DOMRect()
    stream.events = [
      user(0, 'first ask'),
      { type: 'thought', seq: 1, content: [{ type: 'text', text: 'the needle is here' }] },
      { type: 'tool', seq: 2, call: { toolCallId: 't', title: 'ls', kind: 'other', status: 'completed' } },
      agent(3, 'done'),
    ]
    stream.busy = false
    useUiStore.setState({ chatDrafts: {}, chatCondensed: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const pressFind = (): void => {
    fireEvent.keyDown(document.body, { code: 'KeyF', key: 'f', ctrlKey: !IS_MAC, metaKey: IS_MAC })
  }
  const find = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' })
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  }

  it('opens from the focused pane only, and unfolds the run and the row holding a match', async () => {
    const { rerender } = show('w1', 'acp-1', false)
    pressFind()
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()

    rerender(pane())
    pressFind()
    expect(document.activeElement).toBe(find())
    expect(screen.queryByText('the needle is here')).toBeNull()
    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    expect(screen.getByText('the needle is here')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('1 of 1')

    // The run a match holds open can still be closed, and stays closed.
    fireEvent.click(screen.getByRole('button', { name: '1 tool call, 1 thought' }))
    expect(screen.queryByText('the needle is here')).toBeNull()

    // Escape hands the keyboard back to the composer.
    fireEvent.keyDown(find(), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    expect(screen.queryByText('the needle is here')).toBeNull()
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
    flushTypedText()
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
    rerender(pane())
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
    flushTypedText()
    vi.unstubAllGlobals()
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

  it('on a phone, fills in a tapped command and waits for Send instead of running it', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
    show()
    type('/co')
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /\/context/ }))
    expect(stream.send).not.toHaveBeenCalled()
    expect(box().value).toBe('/context ')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: '/context' })
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
    flushTypedText()
  })

  it('puts the user on the left, verbatim', () => {
    // Rendered literally: a user typing `**not bold**` meant the asterisks.
    stream.events = [user(0, '**not bold**')]
    const { container } = show()
    expect(screen.getByText('**not bold**')).toBeTruthy()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('.items-end')).toBeNull()
    expect(container.querySelector('.items-start')).toBeTruthy()
  })

  it('dates what the user sent and what woke the agent, with the whole date on hover', () => {
    const sent = new Date(2026, 9, 17, 9, 5).getTime()
    const woke = new Date(2026, 9, 18, 14, 30).getTime()
    vi.setSystemTime(new Date(2026, 9, 18, 16, 0))
    try {
      stream.events = [
        { type: 'user', seq: 0, content: [{ type: 'text', text: 'hi' }], at: sent },
        agent(1, 'hello'),
        { type: 'agent-turn', seq: 2 },
        { type: 'woken', seq: 3, causes: [{ kind: 'monitor' }], at: woke },
        agent(4, 'The deploy finished.'),
        // A record that does not say when is shown undated.
        user(5, 'undated'),
      ]
      const { container } = show()
      const times = [...container.querySelectorAll('time')]
      expect(times.map((t) => t.dateTime)).toEqual([new Date(sent).toISOString(), new Date(woke).toISOString()])
      // Yesterday's carries its date; today's is the time alone. In the
      // browser's own locale, so the expectations are too.
      const label = (at: number, opts: Intl.DateTimeFormatOptions = {}): string =>
        new Date(at).toLocaleString(undefined, { ...opts, hour: 'numeric', minute: '2-digit' })
      expect(times.map((t) => t.textContent)).toEqual([label(sent, { month: 'short', day: 'numeric' }), label(woke)])
      expect(times[0].title).toContain('2026')
      // Above the message it dates, as the caption for what woke the agent is.
      expect(times[0].parentElement?.nextElementSibling?.textContent).toBe('hi')
      // Leading the caption it shares.
      expect(times[1].parentElement?.textContent).toBe(`${label(woke)}·Woken bya monitor`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows times in the zone the viewer set: the one they pinned, or else this device\'s', async () => {
    // One instant, as the record holds it: nothing between it and the pane
    // names a zone, so the pane formats it in the viewer's.
    const at = Date.UTC(2026, 9, 17, 23, 30)
    const zone = process.env.TZ
    const local = (tz: string): string => new Date(at).toLocaleString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    const seenWith = async (setting: { timeZone: string | null; pinned: boolean }): Promise<HTMLTimeElement> => {
      const server = mockFetch({ 'GET /api/config/time-zone': setting })
      stream.events = [{ type: 'user', seq: 0, content: [{ type: 'text', text: 'hi' }], at }]
      const { container } = show()
      await waitFor(() => expect(server.called('GET /api/config/time-zone')).toHaveLength(1))
      // Let the setting's answer render before reading the label.
      await act(async () => { await Promise.resolve() })
      const time = container.querySelector('time')
      if (time === null) throw new Error('no time shown')
      return time
    }
    // This device is in New York, where it is the evening of the 17th; in
    // Tokyo it is the next morning. Each is today where it is seen.
    process.env.TZ = 'America/New_York'
    vi.setSystemTime(at)
    try {
      expect(local('America/New_York')).not.toBe(local('Asia/Tokyo'))
      // Pinned: the user's choice, whatever this device's zone.
      const pinned = await seenWith({ timeZone: 'Asia/Tokyo', pinned: true })
      expect(pinned.textContent).toBe(local('Asia/Tokyo'))
      expect(pinned.title).toBe(new Date(at).toLocaleString(undefined, { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'long' }))
      cleanup()
      // Automatic: this device's zone, though another device reported last.
      expect((await seenWith({ timeZone: 'Asia/Tokyo', pinned: false })).textContent).toBe(local('America/New_York'))
      cleanup()
      // A zone pinned from a device with newer zone data than this browser's.
      expect((await seenWith({ timeZone: 'Mars/Olympus_Mons', pinned: true })).textContent).toBe(local('America/New_York'))
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('skips an event type it does not know, as a server newer than the page sends', () => {
    stream.events = [user(0, 'hi'), { type: 'from-the-future', seq: 1 } as unknown as AcpEvent, agent(2, 'hello')]
    show()
    expect(screen.getByText('hello')).toBeTruthy()
  })

  it.each<[string, string, Record<string, string[]>]>([
    ['as a document', '## Heading\n\nSome **bold** and `code`.\n\n- one\n- two\n',
      { h2: ['Heading'], strong: ['bold'], code: ['code'], li: ['one', 'two'] }],
    // Tokenized with the same classes the diff views use.
    ['a fenced block as highlighted code', 'run it:\n\n```ts\nconst x = 1\n```\n',
      { 'pre code': ['const x = 1'], '.tok-keyword': ['const'] }],
    ['a GFM table', '| a | b |\n| --- | --- |\n| 1 | 2 |\n', { th: ['a', 'b'], td: ['1', '2'] }],
  ])('renders the agent’s markdown: %s', (_, markdown, found) => {
    stream.events = [agent(0, markdown)]
    const { container } = show()
    for (const [selector, texts] of Object.entries(found)) expect(textsOf(container, selector)).toEqual(texts)
    expect(container.textContent).not.toContain('```')
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
    rerender(pane())
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
    rerender(pane())
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
    expect(screen.getByText('mcp.github.get_issue').closest('button')?.getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByText('git status')).toBeNull()
    fireEvent.click(screen.getByText('Show working tree status'))
    expect(screen.getByText('git status').tagName).toBe('PRE')
    expect(screen.getAllByText('Show working tree status')).toHaveLength(1)
  })

  it('spells out a label too long for its row, and only then offers to expand', () => {
    // jsdom lays nothing out, so every element reads as overflowing here.
    const scroll = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(100)
    try {
      const pattern = `grep -rn "${'very long pattern '.repeat(10)}" src`
      stream.events = [toolCall(0, { toolCallId: 't1', title: pattern, kind: 'search', status: 'completed' })]
      show()
      fireEvent.click(screen.getByText(pattern))
      expect(screen.getAllByText(pattern).map((el) => el.tagName)).toEqual(['SPAN', 'P'])
    } finally {
      scroll.mockRestore()
    }
  })

  /** `#` is a line of the file, not a heading, and the code is tokenized
   *  like the diff views. */
  it.each<[string, string | undefined, string, string, string | undefined]>([
    ['as the file, highlighted for its path', '/workspace/a.ts', '# not a heading\nconst x = 1\n', '# not a heading', 'const'],
    // Without a path it can't be highlighted, but it is still not markdown.
    ['that named no file as code anyway', undefined, '## not a heading\n', '## not a heading', undefined],
    // Unwrapping a lone fence assumes the backticks are an adapter's
    // wrapper. For a `.md` that is often wrong: a document whose body is one
    // code sample would lose real characters.
    ['of a markdown file with its own fences', '/workspace/notes.md', '```ts\nconst x = 1\n```\n', '```ts', undefined],
    ['without a path in the language its fence names', undefined, '```python\nimport os\n```\n', 'import os', 'import'],
  ])('shows a read %s', (_, path, text, shows, keyword) => {
    stream.events = [toolCall(0, {
      toolCallId: 't1',
      title: 'Read it',
      kind: 'read',
      ...(path !== undefined ? { locations: [{ path }] } : {}),
      content: [{ type: 'text', text }],
    })]
    const { container } = show()
    fireEvent.click(screen.getByText('Read it'))
    expect(container.querySelector('h1, h2')).toBeNull()
    expect(container.querySelector('.diff-hl')?.textContent).toContain(shows)
    expect(container.querySelector('.tok-keyword')?.textContent).toBe(keyword)
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

  beforeEach(() => {
    stream.events = []
    stream.busy = false
    stream.connected = true
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushTypedText()
  })

  it.each<[string, string, Record<string, string[]>, string]>([
    // Not dropped either: it is shown as text.
    ['leaves raw HTML in a reply inert', 'look:\n\n<script>window.pwned = 1</script>\n\n<b onclick="x()">hi</b>\n',
      { script: [], b: [], '[onclick]': [] }, '<script>'],
    ['neutralizes a javascript: link', '[click](javascript:alert(1))\n', { a: ['click'], '[href*="javascript:"]': [] }, 'click'],
    // An `<img src>` makes a request on render with no click, which could
    // leak whatever the URL encodes.
    ['shows a remote image as a link instead of fetching it', '![a caption](https://evil.example/pixel?leak=secret)\n',
      { img: [] }, 'a caption'],
  ])('%s', (_, markdown, found, shown) => {
    stream.events = [agent(0, markdown)]
    const { container } = show()
    for (const [selector, texts] of Object.entries(found)) expect(textsOf(container, selector)).toEqual(texts)
    expect(container.textContent).toContain(shown)
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
    flushTypedText()
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

  it('expands an answered ask to the call as it ran, even one a subagent made', () => {
    // The main conversation shows a subagent's asks but not its calls, so
    // the answered ask is the only place the command and its output appear.
    const command = `cd ~/scratch${'; node fake.mjs'.repeat(20)}`
    stream.events = [
      {
        ...(ask(0) as Extract<AcpEvent, { type: 'permission-request' }>),
        thread: 'sub-1',
        toolCall: { toolCallId: 'c1', title: command, shell: true, kind: 'execute', status: 'pending' },
      },
      { type: 'permission-resolved', seq: 1, requestId: '5', outcome: 'selected', optionId: 'allow' },
      {
        type: 'tool',
        seq: 2,
        thread: 'sub-1',
        call: {
          toolCallId: 'c1', title: command, shell: true, kind: 'execute', status: 'completed',
          content: [{ type: 'text', text: 'listening on 18923' }],
        },
      },
      { type: 'tool-output', seq: 3, thread: 'sub-1', toolCallId: 'c1', data: 'request served\n' },
    ]
    show()
    expect(screen.queryByText('listening on 18923')).toBeNull()
    fireEvent.click(screen.getByText(/Allow Once/))
    expect(screen.getByText(command, { selector: 'pre' })).toBeTruthy()
    expect(screen.getByText('listening on 18923')).toBeTruthy()
    expect(screen.getByText('request served')).toBeTruthy()
  })

  it('does not repeat a call the conversation already shows under its answered ask', () => {
    stream.events = [
      { type: 'tool', seq: 0, call: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' } },
      ask(1),
      { type: 'permission-resolved', seq: 2, requestId: '5', outcome: 'selected', optionId: 'allow' },
    ]
    show()
    expect(screen.getByText(/Allow Once/).closest('button')?.getAttribute('aria-disabled')).toBe('true')
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
    flushTypedText()
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
    resizeAll()
    expect(top()).toBe(1000)
  })

  it('leaves a reader who scrolled up where they were', () => {
    const { container } = show()
    const list = container.querySelector('.overflow-y-auto') as HTMLElement
    const top = scroller(container, 200, 0)
    // The reader scrolled up to an earlier tool call; the keyboard must not
    // jump them to the bottom.
    fireEvent.scroll(list)
    resizeAll()
    expect(top()).toBe(0)
  })

  it('leaves a reader who starts scrolling up from the tail while events stream', () => {
    const { container, rerender } = show()
    const list = container.querySelector('.overflow-y-auto') as HTMLElement
    const top = scroller(container, 200, 800)
    fireEvent.scroll(list)
    // A zoom or sideways wheel scrolls nothing up, so the pane keeps following
    // the list as it grows. The stub's height is fixed, so a lower scrollTop
    // stands for the growth.
    list.scrollTop = 800
    fireEvent.wheel(list, { deltaY: -100, ctrlKey: true })
    fireEvent.wheel(list, { deltaY: -100, shiftKey: true })
    stream.events = [...stream.events, agent(1, 'zoomed')]
    rerender(pane())
    expect(top()).toBe(1000)
    // The jsdom stub doesn't clamp, so put the reader back at the tail.
    list.scrollTop = 800
    fireEvent.scroll(list)

    // A smooth scroll's first frame, still near the tail.
    list.scrollTop = 790
    fireEvent.scroll(list)
    stream.events = [...stream.events, agent(2, 'streamed')]
    rerender(pane())
    expect(top()).toBe(790)

    // Back at the tail, a wheel up unpins before any scroll event arrives.
    list.scrollTop = 800
    fireEvent.scroll(list)
    fireEvent.wheel(list, { deltaY: -100 })
    stream.events = [...stream.events, agent(3, 'more')]
    rerender(pane())
    expect(top()).toBe(800)
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
    flushTypedText()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('focuses the box when shown', () => {
    show()
    expect(document.activeElement).toBe(box())
  })

  it('leaves the box unfocused on a phone, where focus raises the keyboard', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
    show()
    expect(document.activeElement).not.toBe(box())
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
    stream.subagentTranscripts = {}
    stream.send.mockClear()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    cleanup()
    flushTypedText()
  })

  it('keeps a subagent\'s work out of the conversation, and shows it, working, without a composer, once opened', () => {
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
    expect(screen.getByText('working')).toBeTruthy()

    // Esc goes back to the conversation and its composer.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Delegating.')).toBeTruthy()
    expect(box()).toBeTruthy()
  })

  it('shows a subagent\'s ask in its own view, to answer there, and does not call it working', () => {
    // The server files claude's ask under the thread of the call it is about.
    stream.events = [
      ...stream.events,
      {
        type: 'tool', seq: 5, thread: 'sub-1',
        call: { toolCallId: 's1', title: 'rm -rf dist', kind: 'execute', status: 'pending' },
      },
      {
        type: 'permission-request', seq: 6, thread: 'sub-1', requestId: '9',
        toolCall: { toolCallId: 's1', title: 'rm -rf dist', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
      },
    ]
    show()
    fireEvent.click(within(screen.getByRole('group', { name: 'Agents' })).getByRole('button', { name: 'Agent: Explore' }))
    expect(screen.queryByText('working')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'permission', requestId: '9', optionId: 'allow' })
  })

  it('stops calling a subagent working once it is cancelled, as the agent exiting settles it', () => {
    stream.busy = false
    stream.events = [
      ...stream.events,
      { type: 'subagent', seq: 5, subagent: { id: 'sub-1', name: 'Explore', task: 'find the router', state: 'cancelled' } },
      { type: 'error', seq: 6, message: 'the agent process exited (code 1)' },
    ]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Explore/ }))
    expect(screen.getByText('Looked in src/router.ts.')).toBeTruthy()
    expect(screen.queryByText('working')).toBeNull()
  })

  it('condenses a subagent\'s view to its report from the toggles under its Back bar', () => {
    stream.events = [
      ...stream.events,
      {
        type: 'tool', seq: 5, thread: 'sub-1',
        call: { toolCallId: 's1', title: 'grep router', kind: 'search', status: 'completed' },
      },
      agent(6, 'The router is in src/router.ts.', 'sub-1'),
      subagent(7, 'completed'),
    ]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Explore/ }))
    expect(screen.getByText('grep router')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show key messages only' }))
    expect(useUiStore.getState().chatCondensed).toBe(true)
    expect(screen.queryByText('grep router')).toBeNull()
    expect(screen.queryByText('Looked in src/router.ts.')).toBeNull()
    expect(screen.getByText('The router is in src/router.ts.')).toBeTruthy()
  })

  it('shows subagent and task cards in the condensed view, folding the steps around them', () => {
    stream.busy = false
    stream.events = [user(-1, 'start it'), ...stream.events, subagent(5, 'completed'), shell(6, 'stopped'), agent(7, 'Both done.')]
    useUiStore.setState({ chatCondensed: true })
    show()
    expect(screen.getByRole('button', { name: /Explore/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /npm run dev/ })).toBeTruthy()
    expect(screen.queryByText('Delegating.')).toBeNull()
    expect(screen.getByRole('button', { name: '1 message' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '1 tool call' })).toBeTruthy()
  })

  it('opens a finished subagent from its card, though it has left the strip', () => {
    stream.events = [...stream.events, subagent(5, 'completed')]
    show()
    expect(screen.queryByTitle('Explore')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Explore/ }))
    expect(screen.getByText('Looked in src/router.ts.')).toBeTruthy()
    // The main turn is still busy, but this thread is done.
    expect(screen.queryByText('working')).toBeNull()
    // Its thread is in the record, so its transcript is not read.
    expect(stream.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent-transcript' }))
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByText('Delegating.')).toBeTruthy()
  })

  it('names what woke the agent into a run it started itself, through the condensed view, and opens it', () => {
    stream.busy = false
    stream.events = [
      ...stream.events,
      subagent(5, 'completed'),
      shell(6, 'stopped'),
      { type: 'agent-turn', seq: 7 },
      {
        type: 'woken', seq: 8,
        causes: [{ kind: 'task', id: 'b1', name: 'npm run dev' }, { kind: 'subagent', id: 'sub-1', name: 'Explore' }],
      },
      agent(9, 'Both finished.'),
      { type: 'agent-turn', seq: 10 },
      { type: 'tool', seq: 11, call: { toolCallId: 't10', title: 'curl /health', kind: 'execute', status: 'completed' } },
      agent(12, 'Deploy looks healthy.'),
      // A monitor's wake is known only once its run ends.
      { type: 'woken', seq: 13, causes: [{ kind: 'monitor' }] },
    ]
    useUiStore.setState({ chatCondensed: true })
    show()
    const [first, late] = screen.getAllByText('Woken by').map((el) => el.parentElement)
    expect(first?.textContent).toBe('Woken bybackground task npm run dev,subagent Explore')
    expect(first?.parentElement?.textContent).toContain('Both finished.')
    // Credited to the run's first step, which stays out though it would fold.
    expect(late?.textContent).toBe('Woken bya monitor')
    expect(late?.parentElement?.textContent).toContain('curl /health')

    fireEvent.click(screen.getByRole('button', { name: 'subagent Explore' }))
    expect(screen.getByText('Looked in src/router.ts.')).toBeTruthy()
  })

  it('reads a replayed subagent\'s thread from its own transcript, ending on its report once', () => {
    // A `session/load` replay shows the subagent, finished, with none of its
    // thread.
    stream.busy = false
    stream.events = [
      agent(0, 'Delegating.'),
      { type: 'subagent', seq: 1, subagent: { id: 'sub-2', name: 'Survey', task: 'survey the routes', state: 'completed', summary: 'Three routes.' } },
    ]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Survey/ }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'subagent-transcript', subagentId: 'sub-2' })
    expect(screen.getByText('Three routes.')).toBeTruthy()

    cleanup()
    stream.send.mockClear()
    stream.subagentTranscripts = {
      'sub-2': {
        events: [
          { type: 'tool', thread: 'sub-2', call: { toolCallId: 'g1', title: 'grep -r route src', kind: 'search', status: 'completed' } },
          { type: 'agent', thread: 'sub-2', content: [{ type: 'text', text: 'Three routes.' }] },
        ],
      },
    }
    show()
    fireEvent.click(screen.getByRole('button', { name: /Survey/ }))
    expect(screen.getByText('grep -r route src')).toBeTruthy()
    expect(screen.getAllByText('Three routes.')).toHaveLength(1)
    // Answered already, so not asked again.
    expect(stream.send).not.toHaveBeenCalledWith({ type: 'subagent-transcript', subagentId: 'sub-2' })
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
    rerender(pane())
    expect(screen.getByText('interrupted')).toBeTruthy()
  })

  it('offers no Stop for a task that has ended', () => {
    stream.events = [...stream.events, shell(5, 'stopped')]
    show()
    fireEvent.click(screen.getByRole('button', { name: /^Shellnpm run dev/ }))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})

describe('WorkspaceChat file links', () => {
  const tool = (seq: number, call: Omit<AcpToolCall, 'toolCallId' | 'status'>): AcpEvent =>
    ({ type: 'tool', seq, call: { toolCallId: `t${seq}`, status: 'completed', ...call } })
  const diff = (path: string, oldText: string, newText: string): AcpDiff => ({ type: 'diff', path, oldText, newText })
  const listing: WorkspaceFiles = {
    version: 'v', root: '/workspace', paths: ['packages/a.ts', 'docs/b c.md', 'README.md'],
    symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false,
  }
  const openFile = vi.fn()

  beforeEach(() => {
    stream.events = [
      { type: 'agent', seq: 0, content: [{
        type: 'text',
        // A link's label never links again, and a path outside the checkout
        // never names a file in it.
        text: 'Edited `packages/a.ts:12`, see [the doc](</workspace/docs/b c.md#L3>) and README.md. '
          + 'Not `notes.txt`, [`README.md`](https://example.com/readme), /usr/lib/x/README.md or packages/b.ts. '
          + 'See [`packages/a.ts`](packages/a.ts#L100).',
      }] },
      // Each adapter's shape. claude names the file in the label and puts
      // the line in the location: a Read's offset, an Edit's first hunk.
      tool(1, { title: 'Read README.md (5 - 9)', kind: 'read', locations: [{ path: '/workspace/README.md', line: 5 }] }),
      tool(2, {
        title: 'Edit packages/a.ts', kind: 'edit',
        content: [diff('/workspace/packages/a.ts', 'x', 'y'), diff('/workspace/packages/a.ts', 'p', 'q')],
        locations: [{ path: '/workspace/packages/a.ts', line: 40 }, { path: '/workspace/packages/a.ts', line: 52 }],
      }),
      // codex titles every edit "Editing files" and gives no location.
      tool(3, { title: 'Editing files', kind: 'edit', content: [diff('/workspace/packages/a.ts', 'r', 's')] }),
      tool(4, { title: "Read file '/workspace/README.md'", kind: 'read', locations: [{ path: '/workspace/README.md' }] }),
      // pi and opencode label a call with the bare tool name.
      tool(5, {
        title: 'edit', kind: 'edit', content: [diff('/workspace/packages/a.ts', 't', 'u')],
        locations: [{ path: '/workspace/packages/a.ts', line: 8 }],
      }),
      tool(6, { title: 'read', kind: 'read', locations: [{ path: '/workspace/README.md' }] }),
    ]
    useUiStore.setState({ openFile })
    openFile.mockClear()
  })

  afterEach(() => {
    cleanup()
    stream.events = []
  })

  it('opens checkout files named in messages and tool calls at their lines, once the listing is in', async () => {
    show()
    // Until the listing is in, only the markdown links are links.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['the doc', 'README.md', 'packages/a.ts'])
    act(() => { client.setQueryData(filesKey('w1'), listing) })
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(11))

    const links = screen.getAllByRole('link')
    expect(links.map((l) => [l.textContent, l.getAttribute('title') ?? l.getAttribute('href')])).toEqual([
      ['packages/a.ts:12', 'packages/a.ts:12'],
      ['the doc', 'docs/b c.md:3'],
      ['README.md', 'README.md'],
      ['README.md', 'https://example.com/readme'],
      ['packages/a.ts', 'packages/a.ts:100'],
      ['README.md', 'README.md:5'],
      ['packages/a.ts', 'packages/a.ts:40'],
      ['/workspace/packages/a.ts', 'packages/a.ts'],
      ['/workspace/README.md', 'README.md'],
      ['packages/a.ts', 'packages/a.ts:8'],
      ['README.md', 'README.md'],
    ])
    fireEvent.click(links[1])
    fireEvent.click(links[3].querySelector('code')!)
    fireEvent.click(links[4].querySelector('code')!)
    fireEvent.keyDown(links[6], { key: 'Enter' })
    fireEvent.click(links[9])
    // The Read row's link opens the file without toggling the row.
    fireEvent.click(links[5])
    expect(screen.getByRole('button', { name: /Read README.md/ }).getAttribute('aria-expanded')).toBeNull()
    expect(openFile.mock.calls).toEqual([
      ['w1', 'docs/b c.md', 3], ['w1', 'packages/a.ts', 100], ['w1', 'packages/a.ts', 40],
      ['w1', 'packages/a.ts', 8], ['w1', 'README.md', 5],
    ])
  })

  it('opens the page a tool call names, in a new tab, but links no URL a message left unlinked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    stream.events = [
      // A URL in a link's label is the label, not a second link.
      { type: 'agent', seq: 0, content: [{ type: 'text', text: '[**https://shown.example/x**](https://target.example/y)' }] },
      // A checkout path inside a URL is part of the URL.
      tool(1, { title: 'Fetch https://github.com/o/r/blob/main/README.md', kind: 'fetch' }),
      // A row with nothing to expand, as codex sends a web search.
      tool(2, { title: 'Open page: https://en.wikipedia.org/wiki/Foo_(bar).', kind: 'search' }),
      tool(3, { title: 'webfetch http://127.0.0.1:8080/page.', kind: 'fetch' }),
    ]
    show()
    act(() => { client.setQueryData(filesKey('w1'), listing) })
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(4))
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'https://shown.example/x',
      'https://github.com/o/r/blob/main/README.md',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'http://127.0.0.1:8080/page',
    ])
    expect(links[0].getAttribute('href')).toBe('https://target.example/y')
    // A browser delivers no click inside a disabled button.
    const row = screen.getByRole<HTMLButtonElement>('button', { name: /Open page/ })
    expect([row.disabled, row.getAttribute('aria-disabled')]).toEqual([false, 'true'])
    fireEvent.click(links[2])
    expect(open).toHaveBeenCalledWith('https://en.wikipedia.org/wiki/Foo_(bar)', '_blank', 'noopener,noreferrer')
    expect(openFile).not.toHaveBeenCalled()
    open.mockRestore()
  })
})

describe('WorkspaceChat pages', () => {
  afterEach(() => {
    cleanup()
    stream.page = 0
    stream.life = undefined
    stream.events = []
    stream.send.mockClear()
    vi.unstubAllGlobals()
  })

  it('reads the pages before the one it attached to above it, and still sends from the latest', async () => {
    const server = mockFetch({
      'GET /api/workspace/w1/agent-sessions/acp-1/transcript': { page: 0, events: [user(0, 'the first ask')] },
    })
    // Attached past a compaction: its `hello` is the conversation's last page.
    stream.page = 1
    stream.events = [
      { type: 'compaction', seq: ACP_PAGE_SPAN, compaction: { id: 'c1', status: 'completed', trigger: 'manual' } },
      agent(ACP_PAGE_SPAN + 1, 'the latest answer'),
    ]
    const { container } = show()
    // jsdom lays nothing out, so the reader sits at the top and the page
    // before loads above.
    expect(await screen.findByText('the first ask')).toBeTruthy()
    expect(server.called('GET /api/workspace/w1/agent-sessions/acp-1/transcript').map((c) => c.query.get('page'))).toEqual(['0'])
    const text = container.textContent ?? ''
    expect(text.indexOf('the first ask')).toBeLessThan(text.indexOf('Conversation compacted'))
    expect(text.indexOf('Conversation compacted')).toBeLessThan(text.indexOf('the latest answer'))

    type('and now?')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(stream.send).toHaveBeenCalledWith({ type: 'prompt', text: 'and now?' })
  })

  it('starts over when the agent restarts, never joining a page read for the life before', async () => {
    // A restart reads the life before back from the tool's history and pages
    // it afresh, so page 1 is a different page afterwards.
    let life = 'L1'
    const pages: Record<string, AcpEvent[][]> = {
      L1: [[user(0, 'the first ask')]],
      L2: [[user(0, 'the first ask')], [user(ACP_PAGE_SPAN, 'the old life, read back')]],
    }
    const route = 'GET /api/workspace/w1/agent-sessions/acp-1/transcript'
    const server = mockFetch({
      [route]: (c: { query: URLSearchParams }) => ({ page: Number(c.query.get('page')), life, events: pages[life][Number(c.query.get('page'))] }),
    })
    stream.page = 1
    stream.life = 'L1'
    stream.events = [agent(ACP_PAGE_SPAN, 'the old life, live')]
    const view = show()
    expect(await screen.findByText('the first ask')).toBeTruthy()

    // The pane's next hello is the new life's last page.
    life = 'L2'
    stream.page = 2
    stream.life = 'L2'
    stream.events = [agent(2 * ACP_PAGE_SPAN, 'after the restart')]
    view.rerender(<QueryClientProvider client={client}>{pane()}</QueryClientProvider>)
    expect(await screen.findByText('the old life, read back')).toBeTruthy()
    expect(screen.getByText('after the restart')).toBeTruthy()
    expect(screen.queryByText('the old life, live')).toBeNull()
    // Each life's pages were read for that life.
    expect(server.called(route).map((c) => c.query.get('page'))).toEqual(['0', '1', '0'])
  })
})
