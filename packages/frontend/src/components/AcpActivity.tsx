import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  active, MAX_TOOL_OUTPUT_CHARS, StateMark, SUBAGENT_CATEGORY, taskCategory, ToolRow, type ActivityCategory,
} from '#components/AcpTranscript'
import { NavBackIcon, StopIcon } from '#lib/icons'
import type { TaskOutput } from '#lib/acp'
import { stripAnsi } from '@yaac/shared/ansi'
import type { AcpEvent, AcpSubagent, AcpTask, AcpToolCall } from '@yaac/shared/acp'

/**
 * What an ACP conversation has running beside its main thread, the way a
 * TUI lists its background agents and shells: a strip of what is still
 * going, and the views a pane switches to when one is opened (a subagent's
 * own transcript, or a task's output).
 */

/** Each subagent and task in the stream at its latest state, in the order
 *  they started. */
export function latestActivity(events: AcpEvent[]): {
  subagents: Map<string, AcpSubagent>
  tasks: Map<string, AcpTask>
} {
  const subagents = new Map<string, AcpSubagent>()
  const tasks = new Map<string, AcpTask>()
  for (const e of events) {
    if (e.type === 'subagent') subagents.set(e.subagent.id, e.subagent)
    if (e.type === 'task') tasks.set(e.task.id, e.task)
  }
  return { subagents, tasks }
}

/** A call at its latest state and the output it streamed, from whichever
 *  thread ran it: what started a task. */
export function callOf(events: AcpEvent[], toolCallId: string): { call?: AcpToolCall; output: string } {
  let call: AcpToolCall | undefined
  let output = ''
  for (const e of events) {
    if (e.type === 'tool' && e.call.toolCallId === toolCallId) call = e.call
    if (e.type === 'tool-output' && e.toolCallId === toolCallId) output = (output + e.data).slice(-MAX_TOOL_OUTPUT_CHARS)
  }
  return { ...(call !== undefined ? { call } : {}), output }
}

/** One open view's id; the strip marks it. */
export type ActivityTarget = { kind: 'subagent' | 'task'; id: string }

/**
 * Everything still running, one chip each, grouped by category under a
 * label and count ("Shells 2"), the way agent TUIs summarize what is left
 * running; nothing when all is idle. On a phone the strip scrolls past a
 * few rows rather than squeezing the transcript.
 */
export function ActivityBar({
  subagents,
  tasks,
  current,
  onOpen,
}: {
  subagents: Map<string, AcpSubagent>
  tasks: Map<string, AcpTask>
  current?: ActivityTarget
  onOpen: (target: ActivityTarget) => void
}): JSX.Element | null {
  const chips = [
    ...[...subagents.values()].filter(active).map((s) => (
      { kind: 'subagent' as const, id: s.id, name: s.name, category: SUBAGENT_CATEGORY, state: s.state }
    )),
    ...[...tasks.values()].filter((t) => active(t) && t.ambient !== true).map((t) => (
      { kind: 'task' as const, id: t.id, name: t.name, category: taskCategory(t), state: t.state }
    )),
  ]
  if (chips.length === 0) return null
  const groups = new Map<string, typeof chips>()
  for (const c of chips) groups.set(c.category.label, [...groups.get(c.category.label) ?? [], c])
  return (
    <div role="group" aria-label="Running in the background" className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1 max-md:max-h-24 max-md:overflow-y-auto">
      {[...groups.values()].map((members) => {
        const { plural, label } = members[0].category
        return (
          <div key={label} role="group" aria-label={plural} className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-text-faint">
              {plural} <span className="tabular-nums text-text-dim">{members.length}</span>
            </span>
            {members.map(({ kind, id, name, category: { icon: Icon, tint }, state }) => (
              <button
                key={`${kind}:${id}`}
                type="button"
                onClick={() => onOpen({ kind, id })}
                title={name}
                aria-label={`${label}: ${name}`}
                className={clsx(
                  'flex max-w-60 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] max-md:py-1.5',
                  current?.kind === kind && current.id === id
                    ? 'border-border-strong bg-surface-3 text-text'
                    : 'border-hairline bg-surface text-text-dim hover:bg-surface-2 hover:text-text',
                )}
              >
                <Icon size={12} className={clsx('shrink-0', tint)} />
                <span className="truncate">{name}</span>
                <StateMark state={state} live />
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** The bar over a subagent's or task's view, with the way back. */
export function ActivityHeader({
  category: { icon: Icon, label, tint },
  title,
  state,
  live,
  onBack,
  children,
}: {
  category: ActivityCategory
  title: string
  state: (AcpSubagent | AcpTask)['state']
  live: boolean
  onBack: () => void
  /** Actions beside the state, such as Stop. */
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2 text-xs">
      <button
        type="button"
        onClick={onBack}
        title="Back to the conversation (Esc)"
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-text-dim hover:bg-surface-2 hover:text-text"
      >
        <NavBackIcon size={13} />
        Back
      </button>
      <Icon size={14} className={clsx('shrink-0', tint)} />
      <span className="shrink-0 text-text-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate text-text">{title}</span>
      {children}
      <StateMark state={state} live={live} />
    </div>
  )
}

/** How often an open, running task's output is re-read. */
const OUTPUT_POLL_MS = 2000

/**
 * A background task: what started it and the end of its output. Output is
 * read one of two ways, as adapters differ: from its output file through
 * `onRefresh` (re-read while it runs), or, for a task with no file (codex
 * streams a shell's output onto the call that started it), as `streamed`.
 * Without either (a stopped workspace's file) only the record is shown.
 */
export function TaskView({
  task,
  call,
  streamed = '',
  output,
  live,
  onRefresh,
}: {
  task: AcpTask
  /** The tool call that started it, when it is in the transcript. */
  call?: AcpToolCall
  /** The output the starting call streamed. */
  streamed?: string
  output?: TaskOutput
  live: boolean
  onRefresh?: () => void
}): JSX.Element {
  const polling = live && active(task)
  // A ref, since the caller's closure is new each render and re-arming on
  // it would re-read every render.
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  const readable = onRefresh !== undefined
  useEffect(() => {
    if (!readable) return
    refreshRef.current?.()
    if (!polling) return
    const timer = setInterval(() => refreshRef.current?.(), OUTPUT_POLL_MS)
    return () => clearInterval(timer)
  }, [task.id, polling, readable])

  return (
    <div className="space-y-3 text-xs">
      {task.description !== '' && task.description !== task.name && (
        <p className="text-text-dim">{task.description}</p>
      )}
      {call !== undefined && <ToolRow call={call} />}
      {task.summary !== undefined && <p className="text-text-dim">{task.summary}</p>}
      {readable ? (
        output?.error !== undefined ? (
          <p className="text-text-faint">The output could not be read: {output.error}.</p>
        ) : (
          <OutputView text={output === undefined ? 'Reading the output…' : output.text ?? ''} />
        )
      ) : task.outputFile === undefined && call !== undefined && (
        <OutputView text={streamed} />
      )}
    </div>
  )
}

function OutputView({ text }: { text: string }): JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface px-2.5 py-1.5
      font-mono text-[11px] leading-snug text-text-dim">
      {stripAnsi(text) || '(no output yet)'}
    </pre>
  )
}

/** Stop a running task; shown in its header. */
export function StopTaskButton({ onStop }: { onStop: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-text-dim
        hover:bg-surface-2 hover:text-text"
    >
      <StopIcon size={10} fill="currentColor" />
      Stop
    </button>
  )
}
