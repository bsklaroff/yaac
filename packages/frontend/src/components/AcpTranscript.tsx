import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { CodeView } from '#components/CodeView'
import { DiffView } from '#components/DiffView'
import { Markdown } from '#components/Markdown'
import { codeLines, unfence } from '#lib/code'
import { diffStats, diffTextPair, type DiffLine } from '#lib/diff'
import { languageForFence, languageForPath } from '#lib/highlight'
import { WarningIcon, ChevronIcon } from '#lib/icons'
import type {
  AcpContent, AcpDiff, AcpEvent, AcpPermissionOption, AcpPlanEntry, AcpToolCall,
  AcpToolContent,
} from '@yaac/shared/acp'

/**
 * How an ACP conversation is drawn — messages, thinking, tool calls, plans.
 *
 * Split out from the chat pane because a conversation is worth reading in two
 * places that share nothing else: the live pane, which owns a socket, a draft
 * and a composer, and a *stopped* worktree's transcript, which owns none of
 * them and is a plain fetch. Both render the same events, so both render them
 * through here; the transport is the caller's business.
 *
 * Everything below is pure over the events it is handed. Nothing reaches for a
 * connection, a store or a worktree id, which is the property that makes a
 * conversation from a pod that no longer exists render exactly like a live
 * one.
 *
 * Rendering is deliberately chunk-driven. The agent emits text in small pieces
 * and each one is its own event, so consecutive events of the same kind are
 * coalesced into one bubble at render time. Buffering whole messages
 * server-side would be simpler and would cost the thing that makes a live pane
 * feel live.
 */

/** Consecutive same-kind text events read as one message. */
export type Group =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'agent'; seq: number; text: string }
  | { kind: 'thought'; seq: number; text: string }
  | { kind: 'tool'; seq: number; call: AcpToolCall }
  | { kind: 'plan'; seq: number; entries: AcpPlanEntry[] }
  | { kind: 'error'; seq: number; message: string }
  | { kind: 'turn-end'; seq: number; stopReason: string }
  /**
   * A permission ask and, once it has one, its answer — one group rather than
   * two events' worth, because they are one thing to a reader: a question that
   * is either still on the table or already settled.
   */
  | {
    kind: 'permission'
    seq: number
    requestId: string
    toolCall?: AcpToolCall
    options: AcpPermissionOption[]
    decided?: { outcome: 'selected' | 'cancelled'; optionId?: string }
  }

function textOf(content: AcpContent[]): string {
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.mimeType} image]`)).join('')
}

/** A tool call's prose — everything it produced that isn't an edit. */
function toolTextOf(content: AcpToolContent[] | undefined): string {
  return textOf((content ?? []).filter((c): c is AcpContent => c.type !== 'diff'))
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
 *
 * A third collapse joins a permission ask to its answer, in place: the pending
 * card BECOMES the decided line, so a settled question does not leave a dead
 * set of buttons above the sentence saying which one was pressed. An answer
 * whose request is not in this stream is dropped — under `bypass` the server
 * settles asks itself and both lines are recorded, so the pair is always
 * whole; a lone answer means the record was truncated ahead of it.
 */
export function groupEvents(events: AcpEvent[]): Group[] {
  const groups: Group[] = []
  const toolIndex = new Map<string, number>()
  const permissionIndex = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'commands' || e.type === 'turn-start') continue
    if (e.type === 'permission-request') {
      permissionIndex.set(e.requestId, groups.length)
      groups.push({
        kind: 'permission',
        seq: e.seq,
        requestId: e.requestId,
        ...(e.toolCall !== undefined ? { toolCall: e.toolCall } : {}),
        options: e.options,
      })
      continue
    }
    if (e.type === 'permission-resolved') {
      const at = permissionIndex.get(e.requestId)
      if (at === undefined) continue
      const asked = groups[at]
      if (asked.kind !== 'permission') continue
      groups[at] = {
        ...asked,
        decided: {
          outcome: e.outcome,
          ...(e.optionId !== undefined ? { optionId: e.optionId } : {}),
        },
      }
      continue
    }
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

/**
 * A file read, shown as the file — highlighted for its own path, with the
 * reader's line numbers when it printed any.
 *
 * The alternative is what every other tool call gets, which is markdown: fine
 * for prose, wrong for source. A file's text is not a document to reinterpret,
 * and running it through a markdown parser is actively lossy — a leading `#`
 * becomes a heading, an underscore italicizes, indentation collapses. An edit
 * already escapes that by being a diff; this is the same escape for the other
 * half of what an agent does to a file.
 */
function ReadView({ path, text }: { path?: string; text: string }): JSX.Element {
  const { lines, language } = useMemo(() => {
    const byPath = path !== undefined ? languageForPath(path) : null
    // Some adapters hand a tool's output back inside a markdown fence. Those
    // backticks are the adapter's, not the file's — but the fence's info string
    // is worth keeping: it is what names the language when the call reported no
    // path, or a path whose extension we don't tokenize.
    //
    // Not for a markdown file, though. A `.md` whose whole body is one fenced
    // block is an ordinary document, and unwrapping it would hide characters
    // the file really contains; a `.ts` that is nothing but a fence is not a
    // file that compiles.
    const body = byPath === 'md' ? { text, fence: '' } : unfence(text)
    return {
      lines: codeLines(body.text),
      language: byPath ?? languageForFence(body.fence),
    }
  }, [path, text])
  return <CodeView lines={lines} language={language} className="px-2.5 py-1.5" />
}

function ToolRow({ call }: { call: AcpToolCall }): JSX.Element {
  const diffs = useMemo(
    () => (call.content ?? []).filter((c): c is AcpDiff => c.type === 'diff'),
    [call.content],
  )
  const edits = useMemo(() => groupDiffs(diffs), [diffs])
  const body = toolTextOf(call.content)
  /** A read's body is a file's own text, so it is rendered as source whether or
   *  not the call said which file: the path picks the highlighting, and a call
   *  that reported none is still code, just uncolored. */
  const isRead = call.kind === 'read'
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
          {body !== '' && (isRead ? (
            <div className={clsx('overflow-x-auto', edits.length > 0 && 'border-t border-hairline')}>
              {/* First location, best-effort: `locations` and `content` are
                  merged independently, so a call reporting several files may
                  not name the one this body came from. Picking wrong costs
                  colors and nothing else — the text is shown either way. */}
              <ReadView path={call.locations?.[0]?.path} text={body} />
            </div>
          ) : (
            <div className={clsx('px-2.5 py-1.5 text-[11px] leading-snug text-text-dim', edits.length > 0 && 'border-t border-hairline')}>
              <Markdown>{body}</Markdown>
            </div>
          ))}
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

/** Whether an option says yes. Used for styling only, so an option the agent
 *  gave no kind falls in with the refusals: an unlabelled button is not one to
 *  dress up as the safe default. */
function isAllow(option: AcpPermissionOption | undefined): boolean {
  return option?.kind === 'allow_once' || option?.kind === 'allow_always'
}

/**
 * The agent asking to do something, and the answer once there is one.
 *
 * The call being asked about is rendered by `ToolRow` — the same row it will
 * appear as once it runs — because that is exactly the evidence the decision
 * needs: the command, or the diff, not a restatement of it. An answered ask
 * collapses to a single line naming what was chosen, so a `manual` transcript
 * reads back as the decisions that produced it.
 *
 * Answering is optimistic about the click and not about the outcome: the
 * buttons disable the moment one is pressed, but the card retires only when the
 * server's `permission-resolved` arrives. A send that never left (socket down)
 * re-enables them, because nothing on the far side heard it.
 *
 * With no `onAnswer` there is nothing behind the buttons, so they are not
 * offered: a stopped worktree's transcript can contain an ask whose agent died
 * unanswered, and a live-looking button that silently does nothing is worse
 * than plainly saying the question outlived its conversation.
 */
function PermissionRow({
  requestId,
  toolCall,
  options,
  decided,
  onAnswer,
}: {
  requestId: string
  toolCall?: AcpToolCall
  options: AcpPermissionOption[]
  decided?: { outcome: 'selected' | 'cancelled'; optionId?: string }
  onAnswer?: (requestId: string, optionId?: string) => boolean
}): JSX.Element {
  const [sending, setSending] = useState(false)
  const answer = (optionId?: string): void => {
    if (onAnswer === undefined) return
    setSending(true)
    if (!onAnswer(requestId, optionId)) setSending(false)
  }

  if (decided !== undefined) {
    const chosen = options.find((o) => o.optionId === decided.optionId)
    const allowed = decided.outcome === 'selected' && isAllow(chosen)
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-faint">
        <span className={clsx('shrink-0', allowed ? 'text-[#3fb950]' : 'text-[#f85149]')}>
          {allowed ? '✓' : '✕'}
        </span>
        <span className="truncate">
          {decided.outcome === 'cancelled'
            ? 'permission dismissed'
            : chosen?.name ?? decided.optionId ?? 'answered'}
          {toolCall !== undefined && ` — ${toolCall.title}`}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border border-[#d29922] bg-surface-2 p-2">
      <div className="flex items-center gap-1.5 px-0.5 text-xs text-[#d29922]">
        <WarningIcon size={12} className="shrink-0" />
        {onAnswer === undefined ? 'Permission was never answered' : 'Permission needed'}
      </div>
      {toolCall !== undefined && <ToolRow call={toolCall} />}
      {onAnswer !== undefined && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o.optionId}
              type="button"
              disabled={sending}
              onClick={() => answer(o.optionId)}
              className={clsx(
                'rounded-md border px-2.5 py-1 text-xs disabled:opacity-40',
                isAllow(o)
                  ? 'border-[#3fb950] text-[#3fb950] hover:bg-[#3fb950]/10'
                  : 'border-hairline text-text-dim hover:text-text',
              )}
            >
              {o.name}
            </button>
          ))}
          {/* Always available, even when the agent offered only allows: the
              turn is blocked until this is answered, so a user who wants
              neither needs a way out that is not "restart the worktree". */}
          <button
            type="button"
            disabled={sending}
            onClick={() => answer()}
            className="ml-auto rounded-md px-2 py-1 text-xs text-text-faint hover:text-text-dim disabled:opacity-40"
          >
            Dismiss
          </button>
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

/**
 * A conversation, rendered.
 *
 * Takes groups rather than events so a caller that already needs them — the
 * live pane, which keys its empty state and its scroll-follow on them — folds
 * the stream once instead of twice.
 *
 * `break-words` here rather than on each bubble: overflow-wrap is inherited,
 * so one declaration covers every message, plan entry and tool row. What it
 * guards against is the agent's staple — a path, a URL, a hash — arriving as
 * one unbreakable token, which on a phone is wider than the pane and would
 * turn the conversation into a sideways scroller. Fenced code is exempt by
 * construction: it carries its own horizontal scroller, because breaking a
 * line of code is worse than scrolling it.
 */
export function AcpTranscript({
  groups,
  className,
  onAnswerPermission,
}: {
  groups: Group[]
  className?: string
  /**
   * How to answer a permission ask, when there is anything to answer it with.
   * The live pane passes its socket send; a stopped worktree's transcript
   * passes nothing, and its cards render as the unanswered questions they are.
   */
  onAnswerPermission?: (requestId: string, optionId?: string) => boolean
}): JSX.Element {
  return (
    <div className={clsx('space-y-2.5 break-words text-sm', className)}>
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
        if (g.kind === 'permission') {
          return (
            <PermissionRow
              key={g.seq}
              requestId={g.requestId}
              {...(g.toolCall !== undefined ? { toolCall: g.toolCall } : {})}
              options={g.options}
              {...(g.decided !== undefined ? { decided: g.decided } : {})}
              {...(onAnswerPermission !== undefined ? { onAnswer: onAnswerPermission } : {})}
            />
          )
        }
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
    </div>
  )
}
