import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useAcpStream } from '#lib/acp'
import { DiffView } from '#components/DiffView'
import { Markdown } from '#components/Markdown'
import { diffStats, diffTextPair, type DiffLine } from '#lib/diff'
import { languageForPath } from '#lib/highlight'
import { LoadingIcon, WarningIcon, ChevronIcon } from '#lib/icons'
import { chatDraftKey, useUiStore } from '#store'
import type {
  AcpContent, AcpDiff, AcpEvent, AcpPlanEntry, AcpToolCall, AcpToolContent,
} from '@yaac/shared/acp'

/**
 * The chat pane: an ACP conversation, rendered as messages instead of
 * terminal bytes.
 *
 * This is the `acp` half of the pane-target split — the same slot
 * `WorktreeTerminal` fills for a `tui` conversation, chosen by the pane's
 * target rather than by anything this component knows. It follows
 * `WorktreeChanges`' conventions (own transport, own scroll state, torn down
 * when off-screen) rather than the terminal's keep-alive discipline: there is
 * no PTY to keep warm, because the conversation lives on the server and
 * replays on every attach. The one thing a teardown must not cost is the
 * user's own words, so the draft lives in the ui store rather than here.
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

/** A tool call's prose — everything it produced that isn't an edit. */
function toolTextOf(content: AcpToolContent[] | undefined): string {
  return textOf((content ?? []).filter((c): c is AcpContent => c.type !== 'diff'))
}

/** What the input box held when a `user` event was sent — the text parts only,
 *  so it compares against a draft rather than against a rendering of one. */
function promptText(content: AcpContent[]): string {
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('')
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
 * `turn-start` is dropped outright: it drives the working indicator, and a
 * turn beginning is already visible as the reply that follows it.
 */
export function groupEvents(events: AcpEvent[]): Group[] {
  const groups: Group[] = []
  const toolIndex = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'commands' || e.type === 'turn-start') continue
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

/**
 * One file's edit, as the hunks the agent reported for it.
 *
 * An agent sends one diff block per hunk, each naming the same file, so
 * consecutive blocks are gathered back into the file they describe — a reader
 * wants "this file changed, in these three places", not three anonymous
 * fragments.
 */
interface EditGroup {
  path: string
  hunks: DiffLine[][]
}

function groupDiffs(diffs: AcpDiff[]): EditGroup[] {
  const groups: EditGroup[] = []
  for (const d of diffs) {
    const lines = diffTextPair(d.oldText, d.newText)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.path === d.path) last.hunks.push(lines)
    else groups.push({ path: d.path, hunks: [lines] })
  }
  return groups
}

/** Basename emphasized, directory faint — a long absolute path stays readable
 *  at a glance. */
function PathLabel({ path }: { path: string }): JSX.Element {
  const cut = path.lastIndexOf('/')
  return (
    <>
      {cut !== -1 && <span className="text-text-faint">{path.slice(0, cut + 1)}</span>}
      <span className="text-text-dim">{path.slice(cut + 1)}</span>
    </>
  )
}

function EditGroupView({ group, showPath }: { group: EditGroup; showPath: boolean }): JSX.Element {
  const language = languageForPath(group.path)
  return (
    <div>
      {showPath && (
        <div className="border-b border-hairline px-2.5 py-1 font-mono text-[10px]">
          <PathLabel path={group.path} />
        </div>
      )}
      {group.hunks.map((lines, i) => (
        <div key={i} className={clsx('overflow-x-auto', i > 0 && 'border-t border-hairline')}>
          {/* No line-number gutter: an edit block is a fragment, and its
              positions are within the fragment rather than within the file. */}
          <DiffView lines={lines} language={language} showLineNumbers={false} />
        </div>
      ))}
    </div>
  )
}

function ToolRow({ call }: { call: AcpToolCall }): JSX.Element {
  const diffs = useMemo(
    () => (call.content ?? []).filter((c): c is AcpDiff => c.type === 'diff'),
    [call.content],
  )
  const edits = useMemo(() => groupDiffs(diffs), [diffs])
  const body = toolTextOf(call.content)
  const hasContent = body !== '' || edits.length > 0
  /**
   * The user's own choice, or `null` for "hasn't said". An edit opens by
   * default because the diff is the thing worth reading; everything else stays
   * a one-line row. This is derived per render rather than seeded into state
   * because a tool call arrives `pending` and empty, and grows its content
   * through later updates — an initial value would have been decided before
   * there was anything to decide on.
   */
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = (choice ?? edits.length > 0) && hasContent
  const stats = useMemo(
    () => edits.flatMap((g) => g.hunks).reduce(
      (a, lines) => {
        const s = diffStats(lines)
        return { additions: a.additions + s.additions, deletions: a.deletions + s.deletions }
      },
      { additions: 0, deletions: 0 },
    ),
    [edits],
  )
  const dot = call.status === 'failed'
    ? 'bg-[#f85149]'
    : call.status === 'completed'
      ? 'bg-[#3fb950]'
      : 'bg-[#d29922]'
  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-surface-2">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        disabled={!hasContent}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs disabled:cursor-default"
      >
        <span className={clsx('size-1.5 shrink-0 rounded-full', dot)} />
        <span className="text-text-dim">{call.kind}</span>
        <span className="truncate text-text">{call.title}</span>
        {edits.length > 0 && (
          <span className="ml-auto shrink-0 font-mono text-[10px]">
            {stats.additions > 0 && <span className="text-[#3fb950]">+{stats.additions}</span>}
            {stats.additions > 0 && stats.deletions > 0 && ' '}
            {stats.deletions > 0 && <span className="text-[#f85149]">−{stats.deletions}</span>}
          </span>
        )}
        {hasContent && (
          <ChevronIcon
            size={12}
            className={clsx('shrink-0 text-text-faint', edits.length === 0 && 'ml-auto', open && 'rotate-90')}
          />
        )}
      </button>
      {open && (
        <div className="max-h-96 overflow-auto border-t border-hairline bg-bg">
          {edits.map((group, i) => (
            <div key={i} className={clsx(i > 0 && 'border-t border-hairline')}>
              {/* The row's own title already names the file when there is only
                  one, so a header there would say it twice. */}
              <EditGroupView group={group} showPath={edits.length > 1} />
            </div>
          ))}
          {body !== '' && (
            <div className={clsx('px-2.5 py-1.5 text-[11px] leading-snug text-text-dim', edits.length > 0 && 'border-t border-hairline')}>
              <Markdown>{body}</Markdown>
            </div>
          )}
        </div>
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
        <div className="mt-1 border-l border-hairline pl-2.5 text-text-faint">
          <Markdown>{text}</Markdown>
        </div>
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

export function WorktreeChat({
  worktreeId,
  agentSessionId,
  visible = true,
}: {
  worktreeId: string
  agentSessionId: string
  visible?: boolean
}): JSX.Element {
  const { events, busy, connected, send } = useAcpStream(worktreeId, agentSessionId, visible)
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
            // Left, like everything else, and left literal: a bubble is what
            // marks it as the user's, and what they typed is not the agent's
            // markdown to reinterpret.
            return (
              <div key={g.seq} className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-text">
                  {g.text}
                </div>
              </div>
            )
          }
          if (g.kind === 'agent') {
            return (
              <div key={g.seq} className="text-text">
                <Markdown>{g.text}</Markdown>
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
