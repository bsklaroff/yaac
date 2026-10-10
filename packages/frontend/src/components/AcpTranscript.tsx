import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
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
  InterruptedIcon, MonitorIcon, MoreIcon, PendingIcon, PlanIcon, PreviewIcon, RenameIcon, SearchIcon, SubagentIcon,
  ThinkingIcon, ToolIcon, WarningIcon, WorkflowIcon, type Icon,
} from '#lib/icons'
import { stripAnsi } from '@yaac/shared/ansi'
import type {
  AcpDiff, AcpEvent, AcpImage, AcpStoredImage, AcpPermissionOption, AcpPlanEntry, AcpSubagent, AcpTask, AcpToolCall,
  AcpToolContent, AcpToolKind, AcpWake,
} from '@yaac/shared/acp'

/**
 * Renders an ACP conversation: messages, thinking, tool calls, plans,
 * permission asks, and cards for the subagents and background tasks the
 * agent started. Shared by the live chat pane and a stopped workspace's
 * transcript, so it depends only on the events it is given and the workspace
 * they belong to, for loading stored images (no socket or store).
 *
 * The agent streams text in small chunks, one event each; consecutive
 * same-kind chunks are merged into one bubble at render time so a live pane
 * updates as text arrives.
 */

/** An image in a message or a tool result, inline or stored apart from the
 *  record. */
type MessageImage = AcpImage | AcpStoredImage

/** One rendered unit of a conversation. Text groups keep images separate so
 *  they can be drawn rather than named. `turn` marks the first group of a run
 *  the agent started by itself (`agent-turn`), which ends the turn before it,
 *  and `woken` what woke the agent into that run, when known. */
export type Group = ({ turn?: true; woken?: AcpWake[] } & (
  /** `steered` marks a message added to a running turn, which it does not end. */
  | { kind: 'user'; seq: number; text: string; images: MessageImage[]; steered?: true }
  | { kind: 'agent'; seq: number; text: string; images: MessageImage[] }
  | { kind: 'thought'; seq: number; text: string; images: MessageImage[] }
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
  /** A permission ask, merged with its answer once one arrives. `toolCall`
   *  and `output` follow the call's later updates, which may run in a
   *  subagent's thread this one does not show; `inView` marks a call that
   *  has its own row in this one. */
  | {
    kind: 'permission'
    seq: number
    requestId: string
    toolCall?: AcpToolCall
    output?: string
    inView?: true
    options: AcpPermissionOption[]
    decided?: { outcome: 'selected' | 'cancelled'; optionId?: string }
  }
))

/** A tool call's text output. Its images are drawn under its row instead
 *  (`ToolRow`). */
function toolTextOf(content: AcpToolContent[] | undefined): string {
  return (content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
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
 * - consecutive text chunks of one kind merge into one group, except that a
 *   steered message stands alone;
 * - a tool call's, subagent's or task's updates replace its group in place,
 *   keeping the latest;
 * - a tool call still unfinished when its turn ends is marked interrupted. A
 *   replayed history has no turn boundaries, so the next `user` message also
 *   ends the turn before it, unless it was steered into that turn;
 * - a permission answer replaces its ask in place (an answer with no ask in
 *   the stream, i.e. a truncated record, is dropped), and the ask keeps its
 *   call's latest state and output from whichever thread ran it, marking a
 *   call this thread shows itself;
 * - `turn-end` is kept only for an unusual stop reason, and `turn-start`
 *   and the session's `commands` and `models` are dropped;
 * - `agent-turn` (a run the agent may have started itself) keeps the text
 *   after it from joining the text before, and marks the group after it as
 *   a turn's first. `woken` marks that same group, whenever it arrives.
 */
export function groupEvents(events: AcpEvent[], thread?: string): Group[] {
  const groups: Group[] = []
  const toolIndex = new Map<string, number>()
  const permissionIndex = new Map<string, number>()
  /** Asks by the call they are about. */
  const askIndex = new Map<string, number>()
  let split = false
  /** Where the run an `agent-turn` reported begins, until a group lands there. */
  let turnAt: number | undefined
  /** That run's first group, once one has landed. */
  let turnFirst: number | undefined
  /** What woke the agent into that run, until its first group lands. */
  let woken: AcpWake[] | undefined
  const startTurn = (): void => {
    if (turnAt === undefined || groups.length <= turnAt) return
    groups[turnAt] = { ...groups[turnAt], turn: true, ...(woken !== undefined ? { woken } : {}) }
    turnFirst = turnAt
    turnAt = undefined
    woken = undefined
  }
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
      const { turn, woken: wake } = groups[at]
      groups[at] = {
        ...group, seq: groups[at].seq, ...(turn ? { turn } : {}), ...(wake !== undefined ? { woken: wake } : {}),
      }
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
    startTurn()
    if (e.type === 'tool' || e.type === 'tool-output') {
      const at = askIndex.get(e.type === 'tool' ? e.call.toolCallId : e.toolCallId)
      const ask = at === undefined ? undefined : groups[at]
      if (at !== undefined && ask?.kind === 'permission') {
        groups[at] = e.type === 'tool'
          ? { ...ask, toolCall: e.call }
          : { ...ask, output: ((ask.output ?? '') + e.data).slice(-MAX_TOOL_OUTPUT_CHARS) }
      }
    }
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
    if (e.type === 'agent-turn') {
      split = true
      turnAt = groups.length
      turnFirst = undefined
      woken = undefined
    }
    if (e.type === 'woken') {
      if (!main) continue
      if (turnFirst !== undefined) groups[turnFirst] = { ...groups[turnFirst], woken: e.causes }
      else if (turnAt !== undefined) woken = e.causes
      continue
    }
    if (e.type === 'commands' || e.type === 'models' || e.type === 'usage' || e.type === 'turn-start' || e.type === 'agent-turn') continue
    if (e.type === 'permission-request') {
      permissionIndex.set(e.requestId, groups.length)
      if (e.toolCall !== undefined) askIndex.set(e.toolCall.toolCallId, groups.length)
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
    // An event type this build does not know (a server newer than the
    // loaded page) is skipped rather than read as text.
    if (!('content' in e)) continue
    const last = groups[groups.length - 1]
    const text = e.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    const images = e.content.filter((c) => c.type === 'image')
    const steer = e.type === 'user' && (e.steered === true || (last?.kind === 'user' && last.steered === true))
    if (last !== undefined && last.kind === e.type && !split && !steer) {
      groups[groups.length - 1] = {
        ...last, kind: e.type, text: last.text + text, images: [...last.images, ...images],
      }
      continue
    }
    split = false
    groups.push({
      kind: e.type, seq: e.seq, text, images, ...(e.type === 'user' && e.steered === true ? { steered: true } : {}),
    })
  }
  startTurn()
  for (const [id, at] of askIndex) {
    const g = groups[at]
    if (toolIndex.has(id) && g.kind === 'permission') groups[at] = { ...g, inView: true }
  }
  const tasks = new Map<string, AcpTask>()
  for (const e of events) if (e.type === 'task') tasks.set(e.task.id, e.task)
  for (const task of tasks.values()) {
    const at = task.toolCallId === undefined || !active(task) ? undefined : toolIndex.get(task.toolCallId)
    const g = at === undefined ? undefined : groups[at]
    if (at !== undefined && g?.kind === 'tool') groups[at] = { ...g, background: true }
  }
  // A final report the thread already ends with is not shown twice.
  const last = groups[groups.length - 1]
  if (self?.summary !== undefined && !active(self) && !(last?.kind === 'agent' && last.text.trim() === self.summary.trim())) {
    groups.push({ kind: 'agent', seq: (events[events.length - 1]?.seq ?? 0) + 1, text: self.summary, images: [] })
  }
  return groups
}

/** The groups a find bar matched (see `useConversationFind`), by seq. */
export interface Found {
  /** Groups with a match anywhere, whose folded run a condensed view opens. */
  any: ReadonlySet<number>
  /** Groups with a match in what their row hides until opened. */
  hidden: ReadonlySet<number>
}

/** A tool call's text as [what its row shows, what opening it shows]. */
function toolFindText(call: AcpToolCall, output = ''): [string, string] {
  const diffs = (call.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.oldText ?? '', c.newText] : []))
  return [
    call.description ?? call.title,
    // A described call's title is drawn only for a shell call, as its command.
    [call.description !== undefined && call.shell === true ? call.title : '', toolTextOf(call.content), ...diffs,
      stripAnsi(output)].join('\n'),
  ]
}

/** A group's searchable text as [what its row shows, what opening it shows].
 *  Messages are their markdown source, not the rendered text, so this only
 *  approximates what a find will highlight: it decides which rows to open. */
export function groupFindText(g: Group): [string, string] {
  switch (g.kind) {
    case 'user': case 'agent': return [g.text, '']
    case 'thought': return ['', g.text]
    case 'tool': return toolFindText(g.call, g.output)
    case 'plan': return [g.entries.map((e) => e.content).join('\n'), '']
    case 'subagent': return [`${g.subagent.name}\n${g.subagent.task}`, '']
    case 'task': return [`${g.task.name}\n${g.task.summary ?? ''}`, '']
    case 'error': return [g.message, '']
    case 'turn-end': return [g.stopReason, '']
    case 'permission': {
      if (g.toolCall === undefined) return ['', '']
      const [shown, hidden] = toolFindText(g.toolCall, g.output)
      return g.decided === undefined ? [`${shown}\n${hidden}`, ''] : [g.toolCall.title, hidden]
    }
  }
}

/** A run of groups the condensed view hides behind one row. Keyed by its
 *  first group's seq, which stays put as a live run grows, so the row keeps
 *  its open state. */
interface Folded {
  kind: 'folded'
  seq: number
  groups: Group[]
}

/** Groups the condensed view never hides: the user's prompts, what woke the
 *  agent into a run, and what the user must see or answer. */
function alwaysShown(g: Group): boolean {
  return g.kind === 'user' || g.kind === 'error' || g.kind === 'turn-end' || g.woken !== undefined
    || (g.kind === 'permission' && g.decided === undefined)
}

/**
 * The condensed view of a conversation: each user prompt and the last agent
 * message of each turn. A turn starts at a prompt that is not steered into a
 * running one, or where the agent started a run itself. While the last turn
 * is running (`busy`), its latest message and every step after it stay shown
 * too, or all of the turn if the agent has not written yet. Each run of
 * hidden groups becomes one `Folded`.
 */
function condense(groups: Group[], busy: boolean): (Group | Folded)[] {
  const shown = new Set<number>()
  let start = 0
  const endTurn = (end: number): void => {
    let lastAgent = -1
    for (let i = start; i < end; i++) if (groups[i].kind === 'agent') lastAgent = i
    if (busy && end === groups.length) {
      for (let i = Math.max(lastAgent, start); i < end; i++) shown.add(i)
    } else if (lastAgent !== -1) {
      shown.add(lastAgent)
    }
    start = end
  }
  groups.forEach((g, i) => {
    if ((g.kind === 'user' && g.steered === undefined) || g.turn !== undefined) endTurn(i)
  })
  endTurn(groups.length)
  const out: (Group | Folded)[] = []
  groups.forEach((g, i) => {
    if (shown.has(i) || alwaysShown(g)) {
      out.push(g)
      return
    }
    const last = out[out.length - 1]
    if (last?.kind === 'folded') last.groups.push(g)
    else out.push({ kind: 'folded', seq: g.seq, groups: [g] })
  })
  return out
}

/** How a folded run's groups are counted, in the order they are listed. */
const FOLDED_NOUNS: [Group['kind'], string, string][] = [
  ['agent', 'message', 'messages'],
  ['tool', 'tool call', 'tool calls'],
  ['thought', 'thought', 'thoughts'],
  ['plan', 'plan update', 'plan updates'],
  ['subagent', 'subagent', 'subagents'],
  ['task', 'task', 'tasks'],
  ['permission', 'answered ask', 'answered asks'],
]

/** What a folded run hides, e.g. "5 messages, 20 tool calls". */
function foldedLabel(groups: Group[]): string {
  return FOLDED_NOUNS.flatMap(([kind, one, many]) => {
    const n = groups.filter((g) => g.kind === kind).length
    return n === 0 ? [] : [`${String(n)} ${n === 1 ? one : many}`]
  }).join(', ')
}

/** A message's or tool call's images, each a thumbnail that opens to the
 *  column's width. */
function MessageImages({ images, workspaceId }: { images: MessageImage[]; workspaceId: string }): JSX.Element | null {
  if (images.length === 0) return null
  return (
    <div className="my-1 flex flex-wrap gap-1.5">
      {images.map((image, i) => <MessageImageView key={i} image={image} workspaceId={workspaceId} />)}
    </div>
  )
}

function MessageImageView({ image, workspaceId }: { image: MessageImage; workspaceId: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} className="max-w-full">
      <img
        src={useImageSrc(image, workspaceId)}
        alt=""
        loading="lazy"
        decoding="async"
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
        <div key={i} className={clsx(i > 0 && 'border-t border-hairline')}>
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
 * Whether a one-line label is cut off at its end, re-checked when its text
 * changes or it is resized, so a row can offer to show it in full.
 */
function useClipped(text: string): [RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const check = (): void => setClipped(el.scrollWidth > el.clientWidth)
    check()
    // Absent under jsdom.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  return [ref, clipped]
}

/**
 * A collapsible row's open state. While `reveal` (it holds a find match) the
 * row is open unless the reader closes it then; otherwise it is the reader's
 * own choice, else `byDefault`. A reveal never changes that choice, so the
 * row goes back to it when the reveal ends.
 */
function useOpen(reveal: boolean, byDefault: boolean): [boolean, (open: boolean) => void] {
  const [choice, setChoice] = useState<boolean | null>(null)
  const [shut, setShut] = useState(false)
  useEffect(() => {
    if (!reveal) setShut(false)
  }, [reveal])
  return [
    reveal ? !shut : choice ?? byDefault,
    (open) => (reveal ? setShut(!open) : setChoice(open)),
  ]
}

/**
 * The header line shared by tool calls, thinking and answered asks: a
 * disclosure caret on the left, then an icon and label. Rows with nothing to
 * expand keep the caret's space so their icons line up with their
 * neighbours'. A `busy` row shows a spinner in the icon's place; `tint`
 * colors the icon instead of the faint default.
 */
function DisclosureRow({
  open,
  onToggle,
  expandable,
  icon: Icon,
  busy = false,
  tint,
  children,
}: {
  open: boolean
  onToggle: () => void
  expandable: boolean
  icon: Icon
  busy?: boolean
  tint?: string
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
        : <Icon size={13} className={clsx('shrink-0', tint ?? 'text-text-faint group-enabled:group-hover:text-text-dim')} />}
      {children}
    </button>
  )
}

/**
 * One tool call. `progress` is how to mark an unfinished call: `running`
 * spins, `interrupted` says its turn ended first. Omitted (a call awaiting
 * permission) it gets no mark.
 *
 * The row's label is one line, so whatever it cuts off is repeated in full
 * at the top of the expanded panel: a shell call's command, or any label too
 * long for the row.
 *
 * Images the call returned (a screenshot, a Read of a PNG) show under the
 * row whether or not it is open, since its label rarely says what they show.
 */
export function ToolRow({
  workspaceId,
  call,
  output = '',
  progress,
  asked = false,
  defaultOpen = false,
  reveal = false,
}: {
  /** The workspace the call ran in, for loading its stored images. */
  workspaceId: string
  call: AcpToolCall
  /** Terminal output the call streamed, shown verbatim. */
  output?: string
  progress?: 'running' | 'interrupted'
  /** The call is awaiting permission, so the row is labelled with the command
   *  itself: a description is the model's own words, and approving on it
   *  alone would trust them. */
  asked?: boolean
  /** Expanded until the user collapses it; edits always are. */
  defaultOpen?: boolean
  /** Holds a find match; see `useOpen`. */
  reveal?: boolean
}): JSX.Element {
  const diffs = useMemo(
    () => (call.content ?? []).filter((c): c is AcpDiff => c.type === 'diff'),
    [call.content],
  )
  const edits = useMemo(() => groupDiffs(diffs), [diffs])
  const images = useMemo(
    () => (call.content ?? []).filter((c): c is MessageImage => c.type === 'image'),
    [call.content],
  )
  const description = asked ? undefined : call.description
  const text = toolTextOf(call.content)
  /** claude's adapter also sends a shell call's description as its content,
   *  which would repeat the row's label. */
  const body = description !== undefined && text.trim() === description.trim() ? '' : text
  const isRead = call.kind === 'read'
  const label = description ?? call.title
  const [labelRef, clipped] = useClipped(label)
  /** A label the panel must spell out, unless it is the command the panel
   *  shows anyway. */
  const fullLabel = clipped && !(call.shell === true && description === undefined)
  /** A shell call always expands, to show its command above any output. */
  const hasContent = call.shell === true || fullLabel || body !== '' || output !== '' || edits.length > 0
  /** Edits default open. The default is derived each render because a call
   *  arrives empty and gains content in later updates. */
  const [expanded, setExpanded] = useOpen(reveal, defaultOpen || edits.length > 0)
  const open = expanded && hasContent
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
        onToggle={() => setExpanded(!open)}
        expandable={hasContent}
        icon={KIND_ICON[call.kind]}
        busy={unfinished(call) && progress === 'running'}
      >
        <span
          ref={labelRef}
          className={clsx('truncate', description === undefined && call.kind === 'execute' && 'font-mono text-[11px]')}
        >
          {label}
        </span>
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
          {fullLabel && (
            <p className={clsx(
              'px-2.5 py-1.5 text-[11px] leading-snug whitespace-pre-wrap text-text',
              (call.shell === true || body !== '' || output !== '' || edits.length > 0) && 'border-b border-hairline',
            )}>
              {label}
            </p>
          )}
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
      <div className="ml-[18px]">
        <MessageImages images={images} workspaceId={workspaceId} />
      </div>
    </div>
  )
}

function ThoughtRow({ text, reveal }: { text: string; reveal: boolean }): JSX.Element {
  const [open, setOpen] = useOpen(reveal, false)
  return (
    <div>
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} expandable icon={ThinkingIcon}>
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
 * buttons. Once answered it collapses to one line naming the choice, which
 * expands to the call as it ran unless the call has a row of its own.
 *
 * Buttons disable on click, but the card changes only when the server's
 * `permission-resolved` arrives; a send that fails re-enables them. Without
 * `onAnswer` (a stopped workspace's transcript) no buttons are shown.
 */
function PermissionRow({
  workspaceId,
  requestId,
  toolCall,
  output,
  inView = false,
  options,
  decided,
  onAnswer,
  reveal,
}: {
  workspaceId: string
  requestId: string
  toolCall?: AcpToolCall
  output?: string
  inView?: boolean
  options: AcpPermissionOption[]
  decided?: { outcome: 'selected' | 'cancelled'; optionId?: string }
  onAnswer?: (requestId: string, optionId?: string) => boolean
  reveal: boolean
}): JSX.Element {
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useOpen(reveal, false)
  const answer = (optionId?: string): void => {
    if (onAnswer === undefined) return
    setSending(true)
    if (!onAnswer(requestId, optionId)) setSending(false)
  }

  if (decided !== undefined) {
    const chosen = options.find((o) => o.optionId === decided.optionId)
    const allowed = decided.outcome === 'selected' && isAllow(chosen)
    return (
      <div>
        <DisclosureRow
          open={open}
          onToggle={() => setOpen(!open)}
          expandable={toolCall !== undefined && !inView}
          icon={allowed ? DoneIcon : FailedIcon}
          tint={allowed ? 'text-success' : 'text-error'}
        >
          <span className="truncate">
            {decided.outcome === 'cancelled'
              ? 'permission dismissed'
              : chosen?.name ?? decided.optionId ?? 'answered'}
            {toolCall !== undefined && ` — ${toolCall.title}`}
          </span>
        </DisclosureRow>
        {open && toolCall !== undefined && !inView && (
          <div className="ml-[18px]">
            <ToolRow
              workspaceId={workspaceId}
              call={toolCall}
              {...(output !== undefined ? { output } : {})}
              defaultOpen
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-warning/60 bg-warning/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <WarningIcon size={12} className="shrink-0" />
        {onAnswer === undefined ? 'Permission was never answered' : 'Permission needed'}
      </div>
      {toolCall !== undefined && <ToolRow workspaceId={workspaceId} call={toolCall} asked />}
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

/**
 * What kind of background work a subagent or task is, named and drawn the
 * same way wherever it appears (the running strip, its transcript card, the
 * header of its own view). The tint tells the kinds apart at a glance; the
 * label says it in words.
 */
export interface ActivityCategory {
  icon: Icon
  label: string
  plural: string
  tint: string
}

export const SUBAGENT_CATEGORY: ActivityCategory = {
  icon: SubagentIcon, label: 'Agent', plural: 'Agents', tint: 'text-purple',
}

const TASK_CATEGORIES: Record<string, ActivityCategory> = {
  shell: { icon: ExecuteIcon, label: 'Shell', plural: 'Shells', tint: 'text-link' },
  monitor: { icon: MonitorIcon, label: 'Monitor', plural: 'Monitors', tint: 'text-warning' },
  workflow: { icon: WorkflowIcon, label: 'Workflow', plural: 'Workflows', tint: 'text-accent' },
}

/** A task's category; an adapter's own kind word is shown as it gave it,
 *  and an empty one as a plain task. */
export function taskCategory(task: AcpTask): ActivityCategory {
  const known = TASK_CATEGORIES[task.kind]
  if (known !== undefined) return known
  const kind = task.kind === '' ? 'task' : task.kind
  const label = kind.charAt(0).toUpperCase() + kind.slice(1)
  return { icon: ToolIcon, label, plural: `${label}s`, tint: 'text-text-faint' }
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
  category: { icon: Icon, label, tint },
  title,
  detail,
  state,
  live,
  onOpen,
}: {
  category: ActivityCategory
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
      <Icon size={14} className={clsx('shrink-0', tint)} />
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
  workspaceId,
  groups,
  className,
  busy = false,
  live = false,
  onAnswerPermission,
  onOpenSubagent,
  onOpenTask,
  condensed = false,
  found,
}: {
  workspaceId: string
  groups: Group[]
  className?: string
  /** Hide all but the key messages behind expandable rows (see `condense`). */
  condensed?: boolean
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
  /** What a find bar matched: those rows show open. */
  found?: Found
}): JSX.Element {
  /** The folded runs the reader opened, by seq, and those they closed while
   *  a find match held them open; the same rule as a row's `useOpen`. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set())
  const [heldShut, setHeldShut] = useState<ReadonlySet<number>>(new Set())
  const flip = (seq: number) => (cur: ReadonlySet<number>): ReadonlySet<number> => {
    const next = new Set(cur)
    if (!next.delete(seq)) next.add(seq)
    return next
  }
  const held = (f: Folded): boolean => f.groups.some((g) => found?.any.has(g.seq) === true)
  const isOpen = (f: Folded): boolean => (held(f) ? !heldShut.has(f.seq) : unfolded.has(f.seq))
  const toggle = (f: Folded): void => (held(f) ? setHeldShut : setUnfolded)(flip(f.seq))
  const shown = condensed ? condense(groups, busy) : groups
  const heldKey = shown.flatMap((g) => (g.kind === 'folded' && held(g) ? [g.seq] : [])).join(',')
  useEffect(() => {
    const still = new Set(heldKey.split(',').map(Number))
    setHeldShut((cur) => ([...cur].every((seq) => still.has(seq)) ? cur : new Set([...cur].filter((seq) => still.has(seq)))))
  }, [heldKey])
  const rows = shown.flatMap((g) => (g.kind === 'folded' && isOpen(g) ? [g, ...g.groups] : [g]))
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
      {rows.map((g, i) => (
        <div
          key={g.kind === 'folded' ? `f${String(g.seq)}` : g.seq}
          data-seq={g.kind === 'folded' ? undefined : g.seq}
          className={clsx(i > 0 && (isStep(g) && isStep(rows[i - 1]) ? 'mt-0.5' : 'mt-4'))}
        >
          {g.kind !== 'folded' && g.woken !== undefined && (
            <WokenCaption
              causes={g.woken}
              {...(onOpenSubagent !== undefined ? { onOpenSubagent } : {})}
              {...(onOpenTask !== undefined ? { onOpenTask } : {})}
            />
          )}
          {g.kind === 'folded' ? (
            <DisclosureRow open={isOpen(g)} onToggle={() => toggle(g)} expandable icon={MoreIcon}>
              {foldedLabel(g.groups)}
            </DisclosureRow>
          ) : g.kind === 'subagent' ? (
            <ActivityCard
              category={SUBAGENT_CATEGORY}
              title={g.subagent.name}
              detail={g.subagent.task}
              state={g.subagent.state}
              live={live}
              {...(onOpenSubagent !== undefined ? { onOpen: () => onOpenSubagent(g.subagent.id) } : {})}
            />
          ) : g.kind === 'task' ? (
            <ActivityCard
              category={taskCategory(g.task)}
              title={g.task.name}
              {...(g.task.summary !== undefined ? { detail: g.task.summary } : {})}
              state={g.task.state}
              live={live}
              {...(onOpenTask !== undefined ? { onOpen: () => onOpenTask(g.task.id) } : {})}
            />
          ) : (
            <GroupView
              workspaceId={workspaceId}
              group={g}
              reveal={found?.hidden.has(g.seq) === true}
              {...(g.kind === 'tool' ? { progress: progressOf(g) } : {})}
              {...(onAnswerPermission !== undefined ? { onAnswerPermission } : {})}
            />
          )}
        </div>
      ))}
    </div>
  )
}

const WAKE_NOUNS: Record<AcpWake['kind'], string> = { task: 'background task', monitor: 'monitor', subagent: 'subagent' }

/** What woke the agent into a run it started itself, each cause opening
 *  the task's or subagent's own view. Kept to one line: a cause too long to
 *  fit is cut short with an ellipsis, its full name in its tooltip. */
function WokenCaption({
  causes,
  onOpenSubagent,
  onOpenTask,
}: {
  causes: AcpWake[]
  onOpenSubagent?: (id: string) => void
  onOpenTask?: (id: string) => void
}): JSX.Element {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-x-1 whitespace-nowrap text-[11px] text-text-faint">
      <span className="shrink-0">Woken by</span>
      {causes.map((c, i) => {
        const { id } = c
        const open = c.kind === 'subagent' ? onOpenSubagent : onOpenTask
        const label = c.name === undefined ? `a ${WAKE_NOUNS[c.kind]}` : `${WAKE_NOUNS[c.kind]} ${c.name}`
        const sep = i < causes.length - 1 ? <span className="shrink-0">,</span> : null
        return (
          <span key={i} className="flex min-w-0 items-center">
            {open === undefined || id === undefined ? (
              <span className="truncate" title={label}>{label}</span>
            ) : (
              <button type="button" className="truncate hover:text-text-dim hover:underline" title={label} onClick={() => open(id)}>
                {label}
              </button>
            )}
            {sep}
          </span>
        )
      })}
    </div>
  )
}

/** Tool calls, thinking and folded runs: one-line rows that stack tightly
 *  into a run of steps, set apart from the messages around them. */
function isStep(g: Group | Folded): boolean {
  return g.kind === 'tool' || g.kind === 'thought' || g.kind === 'folded'
}

function GroupView({
  workspaceId,
  group: g,
  reveal,
  progress,
  onAnswerPermission,
}: {
  workspaceId: string
  group: Exclude<Group, { kind: 'subagent' | 'task' }>
  /** Open the row: it holds a find match. */
  reveal: boolean
  /** How to mark an unfinished tool call; see `ToolRow`. */
  progress?: 'running' | 'interrupted'
  onAnswerPermission?: (requestId: string, optionId?: string) => boolean
}): JSX.Element {
  if (g.kind === 'user') {
    // Rendered as plain text, not markdown.
    return (
      <div className="flex flex-col items-start gap-0.5">
        {g.steered === true && <span className="px-1 text-[11px] text-text-faint">sent mid-turn</span>}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-text">
          <MessageImages images={g.images} workspaceId={workspaceId} />
          {g.text}
        </div>
      </div>
    )
  }
  if (g.kind === 'agent') {
    return (
      <div className="leading-relaxed text-text">
        <Markdown>{g.text}</Markdown>
        <MessageImages images={g.images} workspaceId={workspaceId} />
      </div>
    )
  }
  if (g.kind === 'thought') return <ThoughtRow text={g.text} reveal={reveal} />
  if (g.kind === 'tool') {
    return (
      <ToolRow
        workspaceId={workspaceId}
        call={g.call}
        reveal={reveal}
        {...(g.output !== undefined ? { output: g.output } : {})}
        {...(progress !== undefined ? { progress } : {})}
      />
    )
  }
  if (g.kind === 'plan') return <PlanRow entries={g.entries} />
  if (g.kind === 'permission') {
    return (
      <PermissionRow
        workspaceId={workspaceId}
        requestId={g.requestId}
        {...(g.toolCall !== undefined ? { toolCall: g.toolCall } : {})}
        {...(g.output !== undefined ? { output: g.output } : {})}
        inView={g.inView === true}
        reveal={reveal}
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
