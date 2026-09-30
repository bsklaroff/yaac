import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { CodeView } from '#components/CodeView'
import { DiffView } from '#components/DiffView'
import { Markdown } from '#components/Markdown'
import { useImageSrc } from '#lib/attachments'
import { codeLines, unfence } from '#lib/code'
import { diffStats, diffTextPair, type DiffLine } from '#lib/diff'
import { languageForFence, languageForPath } from '#lib/highlight'
import { WarningIcon, ChevronIcon } from '#lib/icons'
import type {
  AcpContent, AcpDiff, AcpEvent, AcpImage, AcpPermissionOption, AcpPlanEntry, AcpToolCall,
  AcpToolContent,
} from '@yaac/shared/acp'

/**
 * Renders an ACP conversation: messages, thinking, tool calls, plans and
 * permission asks. Shared by the live chat pane and a stopped workspace's
 * transcript, so it depends only on the events it is given (no socket, store
 * or workspace id).
 *
 * The agent streams text in small chunks, one event each; consecutive
 * same-kind chunks are merged into one bubble at render time so a live pane
 * updates as text arrives.
 */

/** One rendered unit of a conversation. Text groups keep images separate so
 *  they can be drawn rather than named. */
export type Group =
  | { kind: 'user'; seq: number; text: string; images: AcpImage[] }
  | { kind: 'agent'; seq: number; text: string; images: AcpImage[] }
  | { kind: 'thought'; seq: number; text: string; images: AcpImage[] }
  | { kind: 'tool'; seq: number; call: AcpToolCall }
  | { kind: 'plan'; seq: number; entries: AcpPlanEntry[] }
  | { kind: 'error'; seq: number; message: string }
  | { kind: 'turn-end'; seq: number; stopReason: string }
  /** A permission ask, merged with its answer once one arrives. */
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

/** A tool call's non-diff output as text. */
function toolTextOf(content: AcpToolContent[] | undefined): string {
  return textOf((content ?? []).filter((c): c is AcpContent => c.type !== 'diff'))
}

/**
 * Fold the event stream into renderable groups:
 * - consecutive text chunks of one kind merge into one group;
 * - a tool call's updates replace its group in place, keeping the latest;
 * - a permission answer replaces its ask in place (an answer with no ask in
 *   the stream, i.e. a truncated record, is dropped);
 * - `turn-end` is kept only for an unusual stop reason, and `turn-start`
 *   and `commands` are dropped.
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
    const text = e.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    const images = e.content.filter((c) => c.type === 'image')
    if (last !== undefined && last.kind === e.type) {
      groups[groups.length - 1] = {
        kind: e.type, seq: last.seq, text: last.text + text, images: [...last.images, ...images],
      }
      continue
    }
    groups.push({ kind: e.type, seq: e.seq, text, images })
  }
  return groups
}

/** A message's images, each a thumbnail that opens to the column's width. */
function MessageImages({ images }: { images: AcpImage[] }): JSX.Element | null {
  if (images.length === 0) return null
  return (
    <div className="my-1 flex flex-wrap gap-1.5">
      {images.map((image, i) => <MessageImage key={i} image={image} />)}
    </div>
  )
}

function MessageImage({ image }: { image: AcpImage }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} className="max-w-full">
      <img
        src={useImageSrc(image)}
        alt=""
        className={clsx('max-w-full rounded border border-hairline', !open && 'max-h-48')}
      />
    </button>
  )
}

/** One file's edit. Agents send one diff block per hunk, so consecutive
 *  blocks for the same path are gathered into one group. */
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

/** A path with the directory dimmed and the basename emphasized. */
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
          {/* No line numbers: they would count from the hunk, not the file. */}
          <DiffView lines={lines} language={language} showLineNumbers={false} />
        </div>
      ))}
    </div>
  )
}

/**
 * A file read's output shown as highlighted source rather than markdown,
 * which would mangle it (`#` becomes a heading, `_` italicizes).
 *
 * Some adapters wrap the output in a markdown fence; it is unwrapped, and its
 * info string names the language when the path doesn't. A `.md` file is left
 * as is, since a fence there is part of the document.
 */
function ReadView({ path, text }: { path?: string; text: string }): JSX.Element {
  const { lines, language } = useMemo(() => {
    const byPath = path !== undefined ? languageForPath(path) : null
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
  const isRead = call.kind === 'read'
  const hasContent = body !== '' || edits.length > 0
  /** The user's expand/collapse choice, or `null` if they haven't made one.
   *  Edits default open. The default is derived each render because a call
   *  arrives empty and gains content in later updates. */
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
              <EditGroupView group={group} showPath={edits.length > 1} />
            </div>
          ))}
          {body !== '' && (isRead ? (
            <div className={clsx('overflow-x-auto', edits.length > 0 && 'border-t border-hairline')}>
              {/* Best effort: with several locations the first may not be
                  the file this body came from, which only affects colors. */}
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

/** Whether an option allows the action. Styling only; an option with no
 *  kind is styled as a refusal. */
function isAllow(option: AcpPermissionOption | undefined): boolean {
  return option?.kind === 'allow_once' || option?.kind === 'allow_always'
}

/**
 * A permission ask, showing the tool call as a `ToolRow`, with answer
 * buttons. Once answered it collapses to one line naming the choice.
 *
 * Buttons disable on click, but the card changes only when the server's
 * `permission-resolved` arrives; a send that fails re-enables them. Without
 * `onAnswer` (a stopped workspace's transcript) no buttons are shown.
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
          {/* Always offered: the turn is blocked until the ask is answered,
              even when the agent offered only allow options. */}
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
 * A conversation, rendered from groups (see `groupEvents`) so a caller that
 * also needs them folds the stream only once.
 *
 * `break-words` on the container is inherited by every row, so long paths or
 * URLs wrap instead of widening the pane on a phone. Code blocks scroll
 * horizontally instead.
 */
export function AcpTranscript({
  groups,
  className,
  onAnswerPermission,
}: {
  groups: Group[]
  className?: string
  /** Sends a permission answer; returns false if it could not be sent.
   *  Omitted for a stopped workspace, whose asks render as unanswered. */
  onAnswerPermission?: (requestId: string, optionId?: string) => boolean
}): JSX.Element {
  return (
    <div className={clsx('space-y-2.5 break-words text-sm', className)}>
      {groups.map((g) => {
        if (g.kind === 'user') {
          // Rendered as plain text, not markdown.
          return (
            <div key={g.seq} className="flex justify-start">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-text">
                <MessageImages images={g.images} />
                {g.text}
              </div>
            </div>
          )
        }
        if (g.kind === 'agent') {
          return (
            <div key={g.seq} className="text-text">
              <Markdown>{g.text}</Markdown>
              <MessageImages images={g.images} />
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
