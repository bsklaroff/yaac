import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAcpStream } from '#lib/acp'
import { AcpTranscript, groupEvents } from '#components/AcpTranscript'
import { LoadingIcon } from '#lib/icons'
import { chatDraftKey, useUiStore } from '#store'
import type { AcpContent } from '@yaac/shared/acp'

/**
 * The chat pane: an ACP conversation, rendered as messages instead of
 * terminal bytes.
 *
 * This is the `acp` half of the pane-target split — the same slot
 * `WorktreeTerminal` fills for a `tui` conversation, chosen by the pane's
 * target rather than by anything this component knows. It owns its transport
 * and its scroll state, and it follows the terminal's keep-alive discipline: a
 * pane that goes off-screen stays mounted and holds its socket, because the
 * expensive part of a chat pane is not the conversation (that lives on the
 * server and replays on any attach) but the attach itself, and re-paying it on
 * every switch is what makes the pane feel slow on a bad link. `visible`
 * therefore only decides focus.
 *
 * It is still unmounted for good when the worktree goes away or the pane is
 * closed — and by a reload — so the one thing a teardown must not cost, the
 * user's own words, lives in the ui store rather than here.
 *
 * What a conversation *looks* like is `AcpTranscript`'s, not this component's:
 * a stopped worktree's history is the same conversation with no socket behind
 * it. What is left here is everything that needs one — the stream, the draft,
 * the composer, and the scroll-follow that keeps a streaming reply in view.
 */

/** What the input box held when a `user` event was sent — the text parts only,
 *  so it compares against a draft rather than against a rendering of one. */
function promptText(content: AcpContent[]): string {
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('')
}

export function WorktreeChat({
  worktreeId,
  agentSessionId,
  visible = true,
}: {
  worktreeId: string
  agentSessionId: string
  visible?: boolean
}): JSX.Element {
  const { events, busy, connected, send } = useAcpStream(worktreeId, agentSessionId)
  const setChatDraft = useUiStore((s) => s.setChatDraft)
  const setChatSent = useUiStore((s) => s.setChatSent)
  /**
   * The draft is held locally and mirrored into the store, rather than read
   * from it: this pane is the only writer, so a keystroke needs no round trip
   * through a subscription. The seed is a plain initializer because the pane is
   * keyed by conversation — a different one is a different mount, never a prop
   * change under this state.
   */
  const [draft, setDraft] = useState(
    () => useUiStore.getState().chatDrafts[chatDraftKey(worktreeId, agentSessionId)]?.text ?? '',
  )
  /**
   * A message handed to the socket but not yet echoed back by the server.
   * Writing to a socket is not evidence the server received anything — the
   * connection can drop in between — so the text stays in the box until the
   * conversation's own `user` event comes back. If the connection blips first,
   * what the user typed is still there to send again.
   */
  const [awaitingEcho, setAwaitingEcho] = useState<string | null>(null)
  /** What this pane mounted with — the draft, and the message a previous mount
   *  had handed to the socket without seeing its echo — plus whether the two
   *  have been reconciled against the replayed history yet (see below). */
  const restoredRef = useRef(draft)
  const restoredSentRef = useRef(
    useUiStore.getState().chatDrafts[chatDraftKey(worktreeId, agentSessionId)]?.sent,
  )
  const reconciledRef = useRef(false)
  const groups = useMemo(() => groupEvents(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Follow the tail only while the reader is already there: an agent
  // streaming a long reply must not yank someone back who scrolled up to read
  // an earlier tool call.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [groups])

  // Grow the box to the message. A textarea is `rows` tall and scrolls its own
  // content, so a five-line message would be written through a one-line slot;
  // measuring instead makes the box show what is being typed, up to the
  // max-height the class sets (past which it goes back to scrolling, so a
  // pasted essay can't eat the conversation). Reset to `auto` first — the
  // measurement is of the content, and a previous explicit height would be the
  // floor scrollHeight reports. In a layout effect so the box is never painted
  // at the wrong height, and keyed on the draft so a restored one (mount, or a
  // send that failed) is sized on arrival rather than on the next keystroke.
  // Growing takes the height out of the conversation above, so a reader at the
  // tail is put back on it — the last message is what they were looking at.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    const list = scrollRef.current
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight
  }, [draft])

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  // Keep the store's copy in step, so the text is still there when the pane is
  // torn down off-screen and mounted again. Re-mirroring the restored value on
  // mount is a no-op the setter absorbs.
  useEffect(() => {
    setChatDraft(worktreeId, agentSessionId, draft)
  }, [draft, worktreeId, agentSessionId, setChatDraft])

  /**
   * Settle a restored in-flight message, once, when the first `hello` lands.
   *
   * A sent message stays in the box until the server echoes it, so a pane torn
   * down inside that window restores text that may well have been delivered —
   * showing the user their own message twice and inviting them to send it
   * again. Two questions decide it, and they need different evidence. Is the
   * box holding *the message that was sent*, rather than words that merely
   * read like it? That is the `sent` marker: string equality against the
   * conversation's history would clear a freshly typed "ok" just because the
   * last "ok" was delivered. And did it actually arrive? That is the replayed
   * history, which is the only thing that knows.
   *
   * Both yes: the message landed, and the box is emptied. Either no: the text
   * stays put, which is the whole point of holding it. The marker is dropped
   * regardless — the history has spoken, so nothing is in flight any more.
   */
  useEffect(() => {
    if (reconciledRef.current || !connected) return
    reconciledRef.current = true
    const sent = restoredSentRef.current
    if (sent === undefined) return
    setChatSent(worktreeId, agentSessionId, undefined)
    if (restoredRef.current.trim() !== sent) return
    let lastUser: string | undefined
    for (const e of events) if (e.type === 'user') lastUser = promptText(e.content)
    if (lastUser !== sent) return
    // Only if the box is still untouched — text typed while the socket was
    // coming up is newer than anything the history can speak to.
    setDraft((cur) => (cur === restoredRef.current ? '' : cur))
  }, [connected, events, worktreeId, agentSessionId, setChatSent])

  // The server confirms a message by echoing it as a `user` event. Until then
  // the text stays put; the echo is what clears it.
  useEffect(() => {
    if (awaitingEcho === null) return
    const echoed = events.some((e) => e.type === 'user' && promptText(e.content) === awaitingEcho)
    if (echoed) {
      setDraft('')
      setAwaitingEcho(null)
      setChatSent(worktreeId, agentSessionId, undefined)
    }
  }, [events, awaitingEcho, worktreeId, agentSessionId, setChatSent])

  // A connection that drops before the echo means the message may never have
  // arrived. Stop waiting so the box is usable again — with the text still in
  // it, ready to send once more.
  useEffect(() => {
    if (!connected) setAwaitingEcho(null)
  }, [connected])

  // So does an error. An echo can be waited on forever otherwise: a
  // conversation whose record has failed keeps its connection and its status,
  // and simply never says anything again — which would leave the box locked
  // on a message the user cannot even retype.
  useEffect(() => {
    if (events.length > 0 && events[events.length - 1].type === 'error') setAwaitingEcho(null)
  }, [events])

  const submit = (): void => {
    const text = draft.trim()
    // `busy` matters as much as `connected`: Enter would otherwise bypass the
    // gate the Send button enforces and put a second prompt turn in flight.
    if (text === '' || !connected || busy || awaitingEcho !== null) return
    if (send({ type: 'prompt', text })) {
      setAwaitingEcho(text)
      // Recorded where it outlives this pane: if the pane is torn down before
      // the echo, its successor needs to know this exact text was in flight.
      setChatSent(worktreeId, agentSessionId, text)
      pinnedRef.current = true
    }
  }

  /** Answer a permission ask. Reports whether it left, so a card whose click
   *  never made it onto a dead socket can offer its buttons again. */
  const answerPermission = (requestId: string, optionId?: string): boolean =>
    send({ type: 'permission', requestId, ...(optionId !== undefined ? { optionId } : {}) })

  /**
   * A turn parked on a question. It is `busy` — its prompt is unanswered — but
   * calling it "working…" under the card asking the user to act is the one
   * place that label misreads the room.
   */
  const awaitingPermission = groups.some((g) => g.kind === 'permission' && g.decided === undefined)

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2.5"
      >
        {groups.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-text-faint">
            {connected ? 'No messages yet — say something.' : 'Connecting to the agent…'}
          </div>
        )}
        <AcpTranscript groups={groups} onAnswerPermission={answerPermission} />
        {busy && !awaitingPermission && (
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-text-dim">
            <LoadingIcon size={12} />
            working…
          </div>
        )}
      </div>

      <div className="border-t border-hairline p-2">
        {!connected && (
          <div className="mb-1.5 text-xs text-text-faint">
            Disconnected — the agent keeps working; this pane reattaches automatically.
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift-enter newlines — the convention every agent
              // TUI in the sibling panes already uses.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={connected ? 'Message the agent…' : 'Reconnecting…'}
            readOnly={awaitingEcho !== null}
            // (index.css raises this to 16px at phone width, along with every
            // other text control — under that, focusing one zooms iOS Safari.)
            className="max-h-40 min-h-8 flex-1 resize-none rounded-md border border-hairline
              bg-surface-2 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint
              focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => send({ type: 'cancel' })}
              className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-dim hover:text-text"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim() === '' || !connected || awaitingEcho !== null}
              className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-dim hover:text-text disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
