/**
 * The wire contract for an ACP conversation pane: what the server pushes
 * down `/acp/attach` and what the pane sends back.
 *
 * These are yaac's normalized shapes, not the Agent Client Protocol's own.
 * The server's ACP client (packages/server/src/runtime/agents/acp-*.ts)
 * translates each `session/update` into the small union below, so the pane
 * does not depend on the ACP version the agent's adapter speaks.
 *
 * Every event carries an increasing `seq`, scoped to one attach. Each attach
 * replays acpd's recorded history numbered from zero, then continues with
 * live events, so a pane replaces its list on `hello` instead of merging.
 */

/** A piece of renderable content: ACP's content blocks, minus the kinds the
 *  agent never produces here (such as embedded resources). */
export type AcpContent =
  | { type: 'text'; text: string }
  | AcpImage

/** An image block; `data` is base64. */
export interface AcpImage { type: 'image'; mimeType: string; data: string }

/**
 * A file edit as before/after text, kept structured so a pane can render it
 * as a diff. The texts are one hunk with context, not the whole file, so
 * they carry no file line numbers. `oldText` absent means a new file.
 */
export interface AcpDiff {
  type: 'diff'
  path: string
  oldText?: string
  newText: string
}

/** What a tool call can produce: content or an edit. */
export type AcpToolContent = AcpContent | AcpDiff

/** What a tool call is doing, as ACP reports it. */
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** ACP's tool-call kinds, verbatim. Unknown kinds become `other`. */
export type AcpToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'switch_mode' | 'other'

export interface AcpToolCall {
  /** Reused by later updates to the same call, so a pane updates the row in
   *  place. */
  toolCallId: string
  title: string
  /** Set for a call that runs a shell command, whose title is then the
   *  command line. Adapters also file non-shell calls (codex's MCP tools)
   *  under `execute`, so the kind alone does not say this. */
  shell?: true
  /** What a shell call's command does, in the agent's words. Only claude's
   *  Bash tool asks the model for one; the other agents' shell tools take
   *  just the command. */
  description?: string
  kind: AcpToolKind
  status: AcpToolStatus
  /** Output produced so far — a diff, command output, or free text. */
  content?: AcpToolContent[]
  /** Files the call touched, for a "follow along" jump. */
  locations?: Array<{ path: string; line?: number }>
}

/**
 * One answer the agent offers for a permission ask, verbatim from ACP. A
 * pane styles by `kind`, which is absent when the agent gave none.
 */
export interface AcpPermissionOption {
  optionId: string
  name: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** One entry of the agent's running plan (ACP's `plan` update). */
export interface AcpPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/** A slash command the session accepts. `hint` describes its argument, when
 *  it takes one. */
export interface AcpCommand { name: string; description?: string; hint?: string }

/** A model the session can switch to, by the adapter's own id. */
export interface AcpModel { id: string; name?: string; description?: string }

/** Where a subagent is in its life, as the adapter reports it. */
export type AcpSubagentState = 'running' | 'completed' | 'failed' | 'cancelled' | 'disconnected'

/**
 * A subagent the agent delegated to. Its own messages and tool calls arrive
 * as events whose `thread` is its `id`, so a pane can show it apart from
 * the main conversation.
 */
export interface AcpSubagent {
  /** The subagent's ACP session id, which its events carry as `thread`. */
  id: string
  /** The thread that spawned it; absent when the main conversation did. */
  parent?: string
  name: string
  /** What it was asked to do. */
  task: string
  state: AcpSubagentState
  /** Its final report, when the adapter sends one apart from its messages
   *  (claude does). */
  summary?: string
}

/**
 * Background work whose news woke the agent: a task or subagent that
 * finished, or a monitor that saw an event. `id` is the task's or subagent's
 * id; absent when which of several monitors fired is unknown.
 */
export interface AcpWake {
  kind: 'task' | 'monitor' | 'subagent'
  id?: string
  name?: string
}

/** Where a background task is in its life, as the adapter reports it. */
export type AcpTaskState = 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

/**
 * Background work that outlives the tool call that started it: a shell run
 * in the background, a monitor, a workflow.
 */
export interface AcpTask {
  id: string
  name: string
  /** `shell`, `monitor`, `workflow`, or the adapter's own word. */
  kind: string
  description: string
  state: AcpTaskState
  /** The tool call that started it, when the adapter names one. */
  toolCallId?: string
  /** Where in the workspace its output is written; see `task-output`. */
  outputFile?: string
  /** The adapter's latest summary of what it did. */
  summary?: string
  /** The adapter can stop it (`stop-task`). */
  canStop?: true
  /** Not activity, by the adapter's account (claude's artifact watches,
   *  requested or not), so it has a card but no chip in the running strip. */
  ambient?: true
}

/** Why a prompt turn ended. Anything but `end_turn` is shown to the user. */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

/**
 * One event in a conversation's stream. Text arrives in chunks as the agent
 * emits it; a pane joins consecutive `agent` events into one bubble.
 *
 * `thread` names the subagent (`AcpSubagent.id`) an event belongs to, and is
 * absent for the main conversation.
 */
export type AcpEvent =
  /** A user message, echoed back so live history matches a replay.
   *  `steered` marks one added to a running turn, which it does not end. */
  | { type: 'user'; seq: number; thread?: string; content: AcpContent[]; steered?: true }
  | { type: 'agent'; seq: number; thread?: string; content: AcpContent[] }
  /** Extended thinking. Panes render it collapsed. */
  | { type: 'thought'; seq: number; thread?: string; content: AcpContent[] }
  | { type: 'tool'; seq: number; thread?: string; call: AcpToolCall }
  /** Terminal output a call streamed, to append to what it has shown. Kept
   *  apart from `call.content`: it is raw text, not Markdown, and resending
   *  the whole call per chunk would grow with the square of the output. */
  | { type: 'tool-output'; seq: number; thread?: string; toolCallId: string; data: string }
  | { type: 'plan'; seq: number; thread?: string; entries: AcpPlanEntry[] }
  /** A subagent was spawned or changed state; carries its whole state. */
  | { type: 'subagent'; seq: number; subagent: AcpSubagent }
  /** A background task was started or changed; carries its whole state. */
  | { type: 'task'; seq: number; task: AcpTask }
  /** The slash commands this session accepts, pushed on connect and whenever
   *  they change. */
  | { type: 'commands'; seq: number; commands: AcpCommand[] }
  /** The models this session offers and the one it runs, pushed by the
   *  handshake and again whenever the model changes. */
  | { type: 'models'; seq: number; current?: string; models: AcpModel[] }
  /** How full the context window is, in tokens, as the agent last reported.
   *  A subagent's own window carries its `thread`. */
  | { type: 'usage'; seq: number; thread?: string; used: number; size: number }
  /** A prompt turn began, including one already running when the server
   *  reattached, which this pane did not start. */
  | { type: 'turn-start'; seq: number }
  /** A prompt turn finished; the agent is idle until the next prompt. */
  | { type: 'turn-end'; seq: number; stopReason: AcpStopReason }
  /**
   * The agent reported a run starting, which may be one it began by itself
   * (a background task finishing) with no user message before it. Only
   * separates that run's output from the reply before; it moves no status,
   * which `turn-start`/`turn-end` own.
   */
  | { type: 'agent-turn'; seq: number }
  /** What woke the agent into the run the last `agent-turn` began, when it
   *  started that run itself. */
  | { type: 'woken'; seq: number; causes: AcpWake[] }
  /** The agent, adapter, or transport failed. Ends the turn, not the
   *  conversation; the user can retry. */
  | { type: 'error'; seq: number; message: string }
  /**
   * The agent asks permission and its turn blocks until answered. Under
   * `bypass` the server answers itself. `requestId` is the agent's JSON-RPC
   * request id as a string, unique within one recorded agent run, so a
   * replay can pair each request with its answer.
   */
  | {
    type: 'permission-request'
    seq: number
    thread?: string
    requestId: string
    /** The call being asked about, when the agent named one. */
    toolCall?: AcpToolCall
    options: AcpPermissionOption[]
  }
  /**
   * A permission ask was settled (by the user, the `bypass` auto-answer, or
   * a cancel). Matches the `permission-request` with the same `requestId`.
   */
  | {
    type: 'permission-resolved'
    seq: number
    requestId: string
    outcome: 'selected' | 'cancelled'
    /** Which option was taken. Absent for `cancelled`. */
    optionId?: string
  }

/**
 * An event before the server assigns its `seq`. Distributes over the union
 * because a plain `Omit<AcpEvent, 'seq'>` keeps only the common keys.
 */
export type AcpEventInit = AcpEvent extends infer T
  ? T extends AcpEvent ? Omit<T, 'seq'> : never
  : never

/**
 * A message sent while a turn runs, held by the server until the turn ends
 * because the adapter cannot take it mid-turn (docs/agent-modes.md, "Sending
 * mid-turn"). `images` is a count; the pane shows the message, not its
 * pictures.
 */
export interface AcpQueuedPrompt { id: string; text: string; images: number }

/** Server → pane. */
export type AcpServerMessage =
  /** Sent once per attach, before any event: the recorded conversation,
   *  numbered from zero. Replaces whatever the pane held. */
  | { type: 'hello'; agentSessionId: string; busy: boolean; queued: AcpQueuedPrompt[]; events: AcpEvent[] }
  | { type: 'event'; event: AcpEvent }
  /** The queued messages changed. Not an event: it is current state, not
   *  history, so it replaces what the pane held. */
  | { type: 'queue'; queued: AcpQueuedPrompt[] }
  /** The connection to the agent dropped or came back. acpd keeps the agent
   *  running meanwhile, so a reconnect resumes mid-turn. */
  | { type: 'health'; connected: boolean }
  /** The answer to a `task-output` request: the end of the task's output
   *  file, or why it could not be read. */
  | { type: 'task-output'; taskId: string; text?: string; error?: string }

/** Pane → server. */
export type AcpClientMessage =
  /** A user message. `images` go to the agent as ACP image blocks after the
   *  text, so a message may be images alone; `data` is base64. Allowed
   *  mid-turn: the server steers it into the turn or queues it. */
  | { type: 'prompt'; text: string; images?: AcpImage[] }
  /** Drop a queued message before it is sent to the agent. */
  | { type: 'unqueue'; id: string }
  /** Interrupt the running turn (ACP `session/cancel`). */
  | { type: 'cancel' }
  /**
   * The user's answer to a `permission-request`; no `optionId` means
   * dismissed (sent to the agent as `cancelled`). The server ignores answers
   * to an already settled ask, so two panes cannot both reply.
   */
  | { type: 'permission'; requestId: string; optionId?: string }
  /** Switch the session's model to one a `models` event offered. A refusal
   *  comes back as an `error` event. */
  | { type: 'model'; modelId: string }
  /** Stop a background task the record announced with `canStop`. Its
   *  `stopped` state comes back as a `task` event. */
  | { type: 'stop-task'; taskId: string }
  /** Read the end of a background task's output file. */
  | { type: 'task-output'; taskId: string }

/** The `/pty/attach`-style pane target that addresses one ACP conversation. */
export const ACP_TARGET_PREFIX = 'acp:'

export function acpTarget(agentSessionId: string): string {
  return `${ACP_TARGET_PREFIX}${agentSessionId}`
}

export function isAcpTarget(target: string): boolean {
  return target.startsWith(ACP_TARGET_PREFIX)
}

/** The conversation a pane target names, or undefined if it names something
 *  else. */
export function acpTargetSession(target: string): string | undefined {
  return isAcpTarget(target) ? target.slice(ACP_TARGET_PREFIX.length) : undefined
}
