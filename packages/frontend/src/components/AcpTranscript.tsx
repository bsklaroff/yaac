import { useMemo, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { CodeView } from '#components/CodeView'
import { DiffView } from '#components/DiffView'
import { Markdown } from '#components/Markdown'
import { useImageSrc } from '#lib/attachments'
import { codeLines, unfence } from '#lib/code'
import { diffStats, diffTextPair, type DiffLine } from '#lib/diff'
import { languageForFence, languageForPath } from '#lib/highlight'
import {
  ChevronIcon, DeleteIcon, DoneIcon, ExecuteIcon, FailedIcon, FileTextIcon, InProgressIcon, LoadingIcon, MoveIcon,
  InterruptedIcon, MonitorIcon, PendingIcon, PlanIcon, PreviewIcon, RenameIcon, SearchIcon, SubagentIcon,
  ThinkingIcon, ToolIcon, WarningIcon, type Icon,
} from '#lib/icons'
import { stripAnsi } from '@yaac/shared/ansi'
import type {
  AcpContent, AcpDiff, AcpEvent, AcpImage, AcpPermissionOption, AcpPlanEntry, AcpSubagent, AcpTask, AcpToolCall,
  AcpToolContent, AcpToolKind,
} from '@yaac/shared/acp'

/**
 * Renders an ACP conversation: messages, thinking, tool calls, plans,
 * permission asks, and cards for the subagents and background tasks the
 * agent started. Shared by the live chat pane and a stopped workspace's
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
  /** `interrupted` marks a call whose turn is over though it never finished;
   *  `background` one that runs on as a task (codex's background shell);
   *  `output` is the terminal output it streamed (raw text, not Markdown). */
  | { kind: 'tool'; seq: number; call: AcpToolCall; output?: string; interrupted?: true; background?: true }
  | { kind: 'plan'; seq: number; entries: AcpPlanEntry[] }
  /** A subagent or task, at the point it started, with its latest state. */
  | { kind: 'subagent'; seq: number; subagent: AcpSubagent }
  | { kind: 'task'; seq: number; task: AcpTask }
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

/** Whether a call has yet to complete or fail. claude's adapter keeps a
 *  running call `pending` until it finishes, so `pending` counts too. */
function unfinished(call: AcpToolCall): boolean {
  return call.status === 'pending' || call.status === 'in_progress'
}

/** The events that belong to one thread; the rest concern the whole
 *  conversation. */
const THREADED = ['user', 'agent', 'thought', 'tool', 'tool-output', 'plan', 'permission-request'] as const

/** How much streamed output a call keeps: its end, as a terminal shows. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024
type ThreadedEvent = Extract<AcpEvent, { type: typeof THREADED[number] }>

function isThreaded(e: AcpEvent): e is ThreadedEvent {
  return (THREADED as readonly string[]).includes(e.type)
}

/** Whether a subagent or task is still going. */
export function active(item: AcpSubagent | AcpTask): boolean {
  return item.state === 'running' || item.state === 'paused'
}

/**
 * Fold one thread of the event stream into renderable groups. `thread` is a
 * subagent's id, or undefined for the main conversation:
 * - only that thread's content is kept, except that the main conversation
 *   also keeps every subagent's permission asks, since an unanswered one
 *   blocks the whole turn;
 * - a subagent's card goes in the thread that spawned it, in place of the
 *   call that spawned it when that is in the stream (claude's Agent call),
 *   and its final report, once it has finished, ends its own thread. Task
 *   cards and turn outcomes go in the main conversation;
 * - a call's streamed output is appended to it, keeping the end;
 * - a call that started a task still running is not interrupted by its turn
 *   ending: it runs on in the background;
 * - consecutive text chunks of one kind merge into one group;
 * - a tool call's, subagent's or task's updates replace its group in place,
 *   keeping the latest;
 * - a tool call still unfinished when its turn ends is marked interrupted. A
 *   replayed history has no turn boundaries, so the next `user` message also
 *   ends the turn before it, unless it was steered into that turn;
 * - a permission answer replaces its ask in place (an answer with no ask in
 *   the stream, i.e. a truncated record, is dropped);
 * - `turn-end` is kept only for an unusual stop reason, and `turn-start`
 *   and the session's `commands` and `models` are dropped;
 * - `agent-turn` (a run the agent may have started itself) keeps the text
 *   after it from joining the text before.
 */
export function groupEvents(events: AcpEvent[], thread?: string): Group[] {
  const groups: Group[] = []
  const toolIndex = new Map<string, number>()
  const permissionIndex = new Map<string, number>()
  let split = false
  const cardIndex = new Map<string, number>()
  /** Calls a subagent's card stands in for. */
  const absorbed = new Set<string>()
  /** The subagent this thread is, at its latest state. */
  let self: AcpSubagent | undefined
  const main = thread === undefined
  /** Add a card, or replace it in place once it exists. */
  const card = (key: string, group: Extract<Group, { kind: 'subagent' | 'task' }>): void => {
    const at = cardIndex.get(key)
    if (at !== undefined) {
      groups[at] = { ...group, seq: groups[at].seq } as Group
      return
    }
    cardIndex.set(key, groups.length)
    groups.push(group)
  }
  const interruptOpenCalls = (): void => {
    for (const at of toolIndex.values()) {
      const g = groups[at]
      if (g.kind === 'tool' && unfinished(g.call)) groups[at] = { ...g, interrupted: true }
    }
  }
  for (const e of events) {
    if (e.type === 'subagent' && e.subagent.id === thread) self = e.subagent
    if (e.type === 'subagent') {
      if (e.subagent.parent !== thread) continue
      const key = `s:${e.subagent.id}`
      const call = toolIndex.get(e.subagent.id)
      if (call !== undefined && !cardIndex.has(key)) {
        toolIndex.delete(e.subagent.id)
        absorbed.add(e.subagent.id)
        cardIndex.set(key, call)
      }
      card(key, { kind: 'subagent', seq: e.seq, subagent: e.subagent })
      continue
    }
    if (e.type === 'task') {
      if (main) card(`t:${e.task.id}`, { kind: 'task', seq: e.seq, task: e.task })
      continue
    }
    if (isThreaded(e) && e.thread !== thread && !(main && e.type === 'permission-request')) continue
    if (!main && (e.type === 'turn-end' || e.type === 'error')) continue
    if (e.type === 'turn-start' || (e.type === 'user' && e.steered !== true)) interruptOpenCalls()
    if (e.type === 'agent-turn') split = true
    if (e.type === 'commands' || e.type === 'models' || e.type === 'turn-start' || e.type === 'agent-turn') continue
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
      interruptOpenCalls()
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
    if (e.type === 'tool-output') {
      const at = toolIndex.get(e.toolCallId)
      const g = at === undefined ? undefined : groups[at]
      if (at === undefined || g?.kind !== 'tool') continue
      groups[at] = { ...g, output: ((g.output ?? '') + e.data).slice(-MAX_TOOL_OUTPUT_CHARS) }
      continue
    }
    if (e.type === 'tool') {
      if (absorbed.has(e.call.toolCallId)) continue
      const at = toolIndex.get(e.call.toolCallId)
      if (at !== undefined) {
        groups[at] = { ...(groups[at] as Extract<Group, { kind: 'tool' }>), call: e.call }
        continue
      }
      toolIndex.set(e.call.toolCallId, groups.length)
      groups.push({ kind: 'tool', seq: e.seq, call: e.call })
      continue
    }
    const last = groups[groups.length - 1]
    const text = e.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    const images = e.content.filter((c) => c.type === 'image')
    if (last !== undefined && last.kind === e.type && !split) {
      groups[groups.length - 1] = {
        kind: e.type, seq: last.seq, text: last.text + text, images: [...last.images, ...images],
      }
      continue
    }
    split = false
    groups.push({ kind: e.type, seq: e.seq, text, images })
  }
  const tasks = new Map<string, AcpTask>()
  for (const e of events) if (e.type === 'task') tasks.set(e.task.id, e.task)
  for (const task of tasks.values()) {
    const at = task.toolCallId === undefined || !active(task) ? undefined : toolIndex.get(task.toolCallId)
    const g = at === undefined ? undefined : groups[at]
    if (at !== undefined && g?.kind === 'tool') groups[at] = { ...g, background: true }
  }
  if (self?.summary !== undefined && !active(self)) {
    groups.push({ kind: 'agent', seq: (events[events.length - 1]?.seq ?? 0) + 1, text: self.summary, images: [] })
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

/** The icon drawn beside a tool call, by its ACP kind. */
const KIND_ICON: Record<AcpToolKind, Icon> = {
  read: FileTextIcon,
  edit: RenameIcon,
  delete: DeleteIcon,
  move: MoveIcon,
  search: SearchIcon,
  execute: ExecuteIcon,
  think: ThinkingIcon,
  fetch: PreviewIcon,
  switch_mode: ToolIcon,
  other: ToolIcon,
}

/**
 * The header line shared by tool calls and thinking: a disclosure caret on
 * the left, then an icon and label. Rows with nothing to expand keep the
 * caret's space so their icons line up with their neighbours'. A `busy` row
 * shows a spinner in the icon's place.
 */
function DisclosureRow({
  open,
  onToggle,
  expandable,
  icon: Icon,
  busy = false,
  children,
}: {
  open: boolean
  onToggle: () => void
  expandable: boolean
  icon: Icon
  busy?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!expandable}
      aria-expanded={expandable ? open : undefined}
      className="group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-1
        text-left text-xs text-text-dim enabled:hover:bg-surface-2 enabled:hover:text-text
        disabled:cursor-default"
    >
      <ChevronIcon
        size={12}
        className={clsx(
          'shrink-0 text-text-faint transition-transform',
          open && 'rotate-90',
          !expandable && 'invisible',
        )}
      />
      {busy
        ? <LoadingIcon size={13} aria-label="running" className="shrink-0 animate-spin text-text-faint" />
        : <Icon size={13} className="shrink-0 text-text-faint group-enabled:group-hover:text-text-dim" />}
      {children}
    </button>
  )
}

/**
 * One tool call. `progress` is how to mark an unfinished call: `running`
 * spins, `interrupted` says its turn ended first. Omitted (a call awaiting
 * permission) it gets no mark.
 */
export function ToolRow({
  call,
  output = '',
  progress,
  asked = false,
}: {
  call: AcpToolCall
  /** Terminal output the call streamed, shown verbatim. */
  output?: string
  progress?: 'running' | 'interrupted'
  /** The call is awaiting permission, so the row is labelled with the command
   *  itself: a description is the model's own words, and approving on it
   *  alone would trust them. */
  asked?: boolean
}): JSX.Element {
  const diffs = useMemo(
    () => (call.content ?? []).filter((c): c is AcpDiff => c.type === 'diff'),
    [call.content],
  )
  const edits = useMemo(() => groupDiffs(diffs), [diffs])
  const description = asked ? undefined : call.description
  const text = toolTextOf(call.content)
  /** claude's adapter also sends a shell call's description as its content,
   *  which would repeat the row's label. */
  const body = description !== undefined && text.trim() === description.trim() ? '' : text
  const isRead = call.kind === 'read'
  /** The row shows a shell call's description, or its command truncated, so
   *  a call that runs one always expands to show the command in full above
   *  any output. */
  const hasContent = call.shell === true || body !== '' || output !== '' || edits.length > 0
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
  return (
    <div>
      <DisclosureRow
        open={open}
        onToggle={() => setChoice(!open)}
        expandable={hasContent}
        icon={KIND_ICON[call.kind]}
        busy={unfinished(call) && progress === 'running'}
      >
        {description !== undefined
          ? <span className="truncate">{description}</span>
          : (
            <span className={clsx('truncate', call.kind === 'execute' && 'font-mono text-[11px]')}>
              {call.title}
            </span>
          )}
        {edits.length > 0 && (
          <span className="shrink-0 font-mono text-[10px]">
            {stats.additions > 0 && <span className="text-success">+{stats.additions}</span>}
            {stats.additions > 0 && stats.deletions > 0 && ' '}
            {stats.deletions > 0 && <span className="text-error">−{stats.deletions}</span>}
          </span>
        )}
        {unfinished(call) && progress === 'interrupted' && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
            <InterruptedIcon size={12} />
            interrupted
          </span>
        )}
        {call.status === 'failed' && (
          <FailedIcon size={12} aria-label="failed" className="shrink-0 text-error" />
        )}
      </DisclosureRow>
      {open && (
        <div className="mt-1 mb-1.5 ml-[18px] max-h-96 overflow-auto rounded-lg border border-hairline bg-surface">
          {call.shell === true && (
            /* Capped on its own so a long command leaves its output in view. */
            <pre className={clsx(
              'max-h-40 overflow-auto px-2.5 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap',
              'break-all text-text',
              (body !== '' || output !== '') && 'border-b border-hairline',
            )}>
              <span className="select-none text-text-faint">$ </span>{call.title}
            </pre>
          )}
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
          {output !== '' && (
            <pre className={clsx(
              'px-2.5 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all text-text-dim',
              (body !== '' || edits.length > 0) && 'border-t border-hairline',
            )}>
              {stripAnsi(output)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ThoughtRow({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <DisclosureRow open={open} onToggle={() => setOpen((v) => !v)} expandable icon={ThinkingIcon}>
        Thinking
      </DisclosureRow>
      {open && (
        <div className="mt-1 mb-1.5 ml-[18px] border-l-2 border-hairline pl-3 text-xs text-text-dim">
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
      <div className="flex items-center gap-1.5 py-1 pl-[18px] text-xs text-text-faint">
        {allowed
          ? <DoneIcon size={13} className="shrink-0 text-success" />
          : <FailedIcon size={13} className="shrink-0 text-error" />}
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
    <div className="space-y-2 rounded-lg border border-warning/60 bg-warning/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <WarningIcon size={12} className="shrink-0" />
        {onAnswer === undefined ? 'Permission was never answered' : 'Permission needed'}
      </div>
      {toolCall !== undefined && <ToolRow call={toolCall} asked />}
      {onAnswer !== undefined && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {options.map((o) => (
            <button
              key={o.optionId}
              type="button"
              disabled={sending}
              onClick={() => answer(o.optionId)}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40',
                isAllow(o)
                  ? 'bg-text text-bg hover:opacity-90'
                  : 'border border-border text-text-dim hover:bg-surface-2 hover:text-text',
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

const PLAN_ICON: Record<AcpPlanEntry['status'], Icon> = {
  pending: PendingIcon,
  in_progress: InProgressIcon,
  completed: DoneIcon,
}

function PlanRow({ entries }: { entries: AcpPlanEntry[] }): JSX.Element {
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 text-text-dim">
        <PlanIcon size={13} className="shrink-0 text-text-faint" />
        Plan
        <span className="ml-auto text-text-faint">{done}/{entries.length}</span>
      </div>
      <ul className="space-y-1">
        {entries.map((e, i) => {
          const Icon = PLAN_ICON[e.status]
          return (
            <li
              key={i}
              className={clsx(
                'flex items-start gap-2',
                e.status === 'completed' && 'text-text-faint line-through',
                e.status === 'in_progress' && 'text-text',
                e.status === 'pending' && 'text-text-dim',
              )}
            >
              <Icon
                size={12}
                className={clsx('mt-0.5 shrink-0', e.status === 'in_progress' ? 'text-accent' : 'text-text-faint')}
              />
              <span>{e.content}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The icon for a background task, by its kind. */
export function taskIcon(task: AcpTask): Icon {
  if (task.kind === 'shell') return ExecuteIcon
  if (task.kind === 'monitor') return MonitorIcon
  return ToolIcon
}

/**
 * How far a subagent or task got. `live` says the conversation is running;
 * without it, one still marked running was cut off when the workspace
 * stopped.
 */
export function StateMark({ state, live }: { state: (AcpSubagent | AcpTask)['state']; live: boolean }): JSX.Element {
  if (state === 'running' && live) {
    return <LoadingIcon size={12} aria-label="running" className="shrink-0 animate-spin text-text-faint" />
  }
  if (state === 'completed') return <DoneIcon size={12} aria-label="completed" className="shrink-0 text-success" />
  if (state === 'failed') return <FailedIcon size={12} aria-label="failed" className="shrink-0 text-error" />
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
      <InterruptedIcon size={12} />
      {state === 'running' ? 'unfinished' : state}
    </span>
  )
}

/** A subagent or task in the transcript; opens its own view when the
 *  caller can show one. */
function ActivityCard({
  icon: Icon,
  label,
  title,
  detail,
  state,
  live,
  onOpen,
}: {
  icon: Icon
  label: string
  title: string
  detail?: string
  state: (AcpSubagent | AcpTask)['state']
  live: boolean
  onOpen?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={onOpen === undefined}
      className="group flex w-full items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-left
        text-xs enabled:hover:border-border enabled:hover:bg-surface-2 disabled:cursor-default"
    >
      <Icon size={14} className="shrink-0 text-text-faint" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="shrink-0 text-text-faint">{label}</span>
          <span className="truncate text-text">{title}</span>
        </span>
        {detail !== undefined && detail !== '' && <span className="truncate text-text-faint">{detail}</span>}
      </span>
      <StateMark state={state} live={live} />
      {onOpen !== undefined && (
        <ChevronIcon size={12} className="shrink-0 text-text-faint group-hover:text-text-dim" />
      )}
    </button>
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
  busy = false,
  live = false,
  onAnswerPermission,
  onOpenSubagent,
  onOpenTask,
}: {
  groups: Group[]
  className?: string
  /** Whether a turn is in flight. Only then can an unfinished call of the
   *  current turn be running; otherwise it reads as interrupted, which also
   *  covers a record cut off before its turn ended. */
  busy?: boolean
  /** Sends a permission answer; returns false if it could not be sent.
   *  Omitted for a stopped workspace, whose asks render as unanswered. */
  onAnswerPermission?: (requestId: string, optionId?: string) => boolean
  /** Whether the conversation is running (see `StateMark`). */
  live?: boolean
  /** Show a subagent's or task's own view; a card is inert without one. */
  onOpenSubagent?: (id: string) => void
  onOpenTask?: (id: string) => void
}): JSX.Element {
  /** Calls waiting on an unanswered ask: not running, and not interrupted. */
  const asking = new Set(groups.flatMap((g) => (
    g.kind === 'permission' && g.decided === undefined && g.toolCall !== undefined ? [g.toolCall.toolCallId] : []
  )))
  const progressOf = (g: Extract<Group, { kind: 'tool' }>): 'running' | 'interrupted' | undefined => {
    if (g.background !== undefined) return 'running'
    if (g.interrupted !== undefined || !busy) return 'interrupted'
    return asking.has(g.call.toolCallId) ? undefined : 'running'
  }
  return (
    <div className={clsx('break-words text-sm', className)}>
      {groups.map((g, i) => (
        <div key={g.seq} className={clsx(i > 0 && (isStep(g) && isStep(groups[i - 1]) ? 'mt-0.5' : 'mt-4'))}>
          {g.kind === 'subagent' ? (
            <ActivityCard
              icon={SubagentIcon}
              label="Agent"
              title={g.subagent.name}
              detail={g.subagent.task}
              state={g.subagent.state}
              live={live}
              {...(onOpenSubagent !== undefined ? { onOpen: () => onOpenSubagent(g.subagent.id) } : {})}
            />
          ) : g.kind === 'task' ? (
            <ActivityCard
              icon={taskIcon(g.task)}
              label={g.task.kind}
              title={g.task.name}
              {...(g.task.summary !== undefined ? { detail: g.task.summary } : {})}
              state={g.task.state}
              live={live}
              {...(onOpenTask !== undefined ? { onOpen: () => onOpenTask(g.task.id) } : {})}
            />
          ) : (
            <GroupView
              group={g}
              {...(g.kind === 'tool' ? { progress: progressOf(g) } : {})}
              {...(onAnswerPermission !== undefined ? { onAnswerPermission } : {})}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/** Tool calls and thinking: one-line rows that stack tightly into a run of
 *  steps, set apart from the messages around them. */
function isStep(g: Group): boolean {
  return g.kind === 'tool' || g.kind === 'thought'
}

function GroupView({
  group: g,
  progress,
  onAnswerPermission,
}: {
  group: Exclude<Group, { kind: 'subagent' | 'task' }>
  /** How to mark an unfinished tool call; see `ToolRow`. */
  progress?: 'running' | 'interrupted'
  onAnswerPermission?: (requestId: string, optionId?: string) => boolean
}): JSX.Element {
  if (g.kind === 'user') {
    // Rendered as plain text, not markdown.
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-text">
          <MessageImages images={g.images} />
          {g.text}
        </div>
      </div>
    )
  }
  if (g.kind === 'agent') {
    return (
      <div className="leading-relaxed text-text">
        <Markdown>{g.text}</Markdown>
        <MessageImages images={g.images} />
      </div>
    )
  }
  if (g.kind === 'thought') return <ThoughtRow text={g.text} />
  if (g.kind === 'tool') {
    return (
      <ToolRow
        call={g.call}
        {...(g.output !== undefined ? { output: g.output } : {})}
        {...(progress !== undefined ? { progress } : {})}
      />
    )
  }
  if (g.kind === 'plan') return <PlanRow entries={g.entries} />
  if (g.kind === 'permission') {
    return (
      <PermissionRow
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
      <div className="flex items-center gap-2 text-[11px] text-text-faint">
        <span className="h-px flex-1 bg-hairline" />
        turn ended: {g.stopReason.replace(/_/g, ' ')}
        <span className="h-px flex-1 bg-hairline" />
      </div>
    )
  }
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
      <WarningIcon size={13} className="mt-px shrink-0" />
      <span>{g.message}</span>
    </div>
  )
}
