// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { AcpClientMessage, AcpEvent } from '@yaac/shared/acp'

/**
 * What the chat pane keeps across a teardown. The pane is unmounted every time
 * it goes off-screen (tab switch, worktree switch, column close), so a draft
 * held in component state would simply vanish — and the awkward case is the
 * one where the draft is a message that was already sent but not yet echoed
 * back, which must NOT come back to haunt the box.
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
