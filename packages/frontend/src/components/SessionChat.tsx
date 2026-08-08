import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useAcpStream } from '#lib/acp'
import { LoadingIcon, WarningIcon, ChevronIcon } from '#lib/icons'
import type { AcpContent, AcpEvent, AcpPlanEntry, AcpToolCall } from '@yaac/shared/acp'

/**
 * The chat pane: an ACP conversation, rendered as messages instead of
 * terminal bytes.
 *
 * This is the `acp` half of the pane-target split — the same slot
 * `SessionTerminal` fills for a `tui` conversation, chosen by the pane's
 * target rather than by anything this component knows. It follows
 * `SessionChanges`' conventions (own transport, own scroll state, torn down
 * when off-screen) rather than the terminal's keep-alive discipline: there is
 * no PTY to keep warm, because the conversation lives on the server and
 * replays on every attach.
 *
 * Rendering is deliberately chunk-driven. The agent emits text in small
 * pieces and each one is its own event, so consecutive events of the same kind
 * are coalesced into one bubble at render time. Buffering whole messages
 * server-side would be simpler and would cost the thing that makes a chat pane
 * feel live.
 */

/** Consecutive same-kind text events read as one message. */
type Group =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'agent'; seq: number; text: string }
  | { kind: 'thought'; seq: number; text: string }
  | { kind: 'tool'; seq: number; call: AcpToolCall }
  | { kind: 'plan'; seq: number; entries: AcpPlanEntry[] }
  | { kind: 'error'; seq: number; message: string }
  | { kind: 'turn-end'; seq: number; stopReason: string }

function textOf(content: AcpContent[]): string {
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.mimeType} image]`)).join('')
}

/**
 * Fold the event stream into renderable groups.
 *
 * Two collapses happen here, both of which the server deliberately does NOT
 * do: consecutive text chunks of one kind merge into a bubble, and a tool
 * call's successive updates collapse onto its latest state (the server sends
 * each update as its own event so a pane can animate the transition, but the
 * last one is what a reader wants to see).
 *
 * `turn-end` is dropped unless it says something — a plain `end_turn` is the
 * expected outcome and rendering it would put a divider under every reply.
 */
export function groupEvents(events: AcpEvent[]): Group[] {
  const groups: Group[] = []
  const toolIndex = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'commands') continue
    if (e.type === 'turn-end') {
      if (e.stopReason !== 'end_turn') {
        groups.push({ kind: 'turn-end', seq: e.seq, stopReason: e.stopReason })
      }
      continue
    }
    if (e.type === 'error') {
      groups.push({ kind: 'error', seq: e.seq, message: e.message })
      continue
    }
    if (e.type === 'plan') {
      groups.push({ kind: 'plan', seq: e.seq, entries: e.entries })
      continue
    }
    if (e.type === 'tool') {
      const at = toolIndex.get(e.call.toolCallId)
      if (at !== undefined) {
        groups[at] = { kind: 'tool', seq: groups[at].seq, call: e.call }
        continue
      }
      toolIndex.set(e.call.toolCallId, groups.length)
      groups.push({ kind: 'tool', seq: e.seq, call: e.call })
      continue
    }
    const last = groups[groups.length - 1]
    const text = textOf(e.content)
    if (last !== undefined && last.kind === e.type) {
      groups[groups.length - 1] = { kind: e.type, seq: last.seq, text: last.text + text }
      continue
    }
    groups.push({ kind: e.type, seq: e.seq, text })
  }
  return groups
}

function ToolRow({ call }: { call: AcpToolCall }): JSX.Element {
  const [open, setOpen] = useState(false)
  const body = call.content ? textOf(call.content) : ''
  const dot = call.status === 'failed'
    ? 'bg-[#f85149]'
    : call.status === 'completed'
      ? 'bg-[#3fb950]'
      : 'bg-[#d29922]'
  return (
    <div className="rounded-md border border-hairline bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={body === ''}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs disabled:cursor-default"
      >
        <span className={clsx('size-1.5 shrink-0 rounded-full', dot)} />
        <span className="text-text-dim">{call.kind}</span>
        <span className="truncate text-text">{call.title}</span>
        {body !== '' && (
          <ChevronIcon size={12} className={clsx('ml-auto shrink-0 text-text-faint', open && 'rotate-90')} />
        )}
      </button>
      {open && body !== '' && (
        <pre className="max-h-80 overflow-auto border-t border-hairline px-2.5 py-1.5 text-[11px] leading-snug text-text-dim">
          {body}
        </pre>
      )}
    </div>
  )
}

function ThoughtRow({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-text-faint hover:text-text-dim"
      >
        <ChevronIcon size={12} className={clsx('shrink-0', open && 'rotate-90')} />
        thinking
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l border-hairline pl-2.5 text-text-faint">{text}</div>
      )}
    </div>
  )
}

function PlanRow({ entries }: { entries: AcpPlanEntry[] }): JSX.Element {
  return (
    <div className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs">
      <div className="mb-1 text-text-dim">plan</div>
      <ul className="space-y-0.5">
        {entries.map((e, i) => (
          <li
            key={i}
            className={clsx(
              'flex gap-1.5',
              e.status === 'completed' && 'text-text-faint line-through',
              e.status === 'in_progress' && 'text-text',
              e.status === 'pending' && 'text-text-dim',
            )}
          >
            <span className="shrink-0">{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '▸' : '·'}</span>
            <span>{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SessionChat({
  worktreeId,
  agentSessionId,
  visible = true,
}: {
  worktreeId: string
  agentSessionId: string
  visible?: boolean
}): JSX.Element {
  const { events, busy, connected, send } = useAcpStream(worktreeId, agentSessionId, visible)
  const [draft, setDraft] = useState('')
  /**
   * A message handed to the socket but not yet echoed back by the server.
   * Writing to a socket is not evidence the server received anything — the
   * connection can drop in between — so the text stays in the box until the
   * conversation's own `user` event comes back. If the connection blips first,
   * what the user typed is still there to send again.
   */
  const [awaitingEcho, setAwaitingEcho] = useState<string | null>(null)
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

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  // The server confirms a message by echoing it as a `user` event. Until then
  // the text stays put; the echo is what clears it.
  useEffect(() => {
    if (awaitingEcho === null) return
    const echoed = events.some((e) => e.type === 'user'
      && e.content.filter((c) => c.type === 'text').map((c) => c.text).join('') === awaitingEcho)
    if (echoed) {
      setDraft('')
      setAwaitingEcho(null)
    }
  }, [events, awaitingEcho])

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
      pinnedRef.current = true
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 text-sm"
      >
        {groups.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-text-faint">
            {connected ? 'No messages yet — say something.' : 'Connecting to the agent…'}
          </div>
        )}
        {groups.map((g) => {
          if (g.kind === 'user') {
            return (
              <div key={g.seq} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-text">
                  {g.text}
                </div>
              </div>
            )
          }
          if (g.kind === 'agent') {
            return (
              <div key={g.seq} className="whitespace-pre-wrap text-text">
                {g.text}
              </div>
            )
          }
          if (g.kind === 'thought') return <ThoughtRow key={g.seq} text={g.text} />
          if (g.kind === 'tool') return <ToolRow key={g.seq} call={g.call} />
          if (g.kind === 'plan') return <PlanRow key={g.seq} entries={g.entries} />
          if (g.kind === 'turn-end') {
            return (
              <div key={g.seq} className="text-xs text-text-faint">
                turn ended: {g.stopReason.replace(/_/g, ' ')}
              </div>
            )
          }
          return (
            <div key={g.seq} className="flex items-start gap-1.5 text-xs text-[#f85149]">
              <WarningIcon size={12} className="mt-0.5 shrink-0" />
              <span>{g.message}</span>
            </div>
          )
        })}
        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-text-dim">
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
            className="max-h-40 min-h-8 flex-1 resize-none rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:outline-none"
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
