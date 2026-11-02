/**
 * The wire contract for an ACP conversation pane: what the server pushes
 * down `/acp/attach` (and `/acp/observe`) and what the pane sends back.
 *
 * These are yaac's normalized shapes, not the Agent Client Protocol's own.
 * The server's ACP client (packages/server/src/runtime/agents/acp-*.ts)
 * translates each `session/update` into the small union below, so the pane
 * does not depend on the ACP version the agent's adapter speaks.
 *
 * A conversation's history is split into pages: a new one starts at each
 * compaction, and when a page grows past a size cap. Every event carries an
 * increasing `seq` that names its page (`acpPageOf`), so events from
 * different reads of one conversation never collide. An attach sends the
 * last page in `hello`, then continues with live events, so a pane replaces
 * its list on `hello` instead of merging; earlier pages are read from the
 * transcript route, for the same agent life (`AcpTranscriptPage.life`).
 */

import type { PermissionMode } from './types'

/** How many `seq` values each page owns: page `n` numbers its events from
 *  `n * ACP_PAGE_SPAN`. */
export const ACP_PAGE_SPAN = 2 ** 32

/** The page an event's `seq` belongs to. */
export function acpPageOf(seq: number): number {
  return Math.floor(seq / ACP_PAGE_SPAN)
}

/**
 * One page of a conversation's history (the transcript route's answer).
 * An `acp` conversation's pages are numbered for the agent life its record
 * holds, `life`, since a restart numbers them afresh; a page from another
 * life is not one a pane can join to its own.
 */
export interface AcpTranscriptPage {
  page: number
  life?: string
  events: AcpEvent[]
}

/** A piece of renderable content: ACP's content blocks, minus the kinds the
 *  agent never produces here (such as embedded resources). */
export type AcpContent =
  | { type: 'text'; text: string }
  | AcpImage
  | AcpStoredImage

/** An image block; `data` is base64. */
export interface AcpImage { type: 'image'; mimeType: string; data: string }

/**
 * An image acpd keeps beside the record rather than in it, named by the
 * SHA-256 of its bytes. A pane loads it from
 * `GET /workspace/:id/acp-images/:hash`.
 */
export interface AcpStoredImage { type: 'image'; mimeType: string; hash: string }

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
  /** It began from a copy of its parent's conversation up to the call that
   *  launched it, rather than from its task alone (claude's fork). */
  fork?: true
  /** The calls that sent it on after it stopped (claude's SendMessage), each
   *  shown as another way into it where it was made. */
  resumedBy?: string[]
  state: AcpSubagentState
  /** When it was spawned (epoch ms, to within a second); absent where the
   *  record does not say. */
  startedAt?: number
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
  /** When it was started (epoch ms, to within a second); absent where the
   *  record does not say. */
  startedAt?: number
  /** The tool call that started it, when the adapter names one. */
  toolCallId?: string
  /** The subagent whose thread started it; absent when the main
   *  conversation did. */
  parent?: string
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

/**
 * The agent compacting its context: it replaced the conversation so far with
 * a summary and carries on from that. What came before stays in the history,
 * so a compaction starts a new page (`ACP_PAGE_SPAN`). The facts are each
 * present when the agent reports them.
 */
export interface AcpCompaction {
  /** Reused by later updates to the same compaction. */
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** Asked for (`/compact`) or started by the agent as the context filled. */
  trigger?: 'manual' | 'auto'
  /** The context's size in tokens before and after. */
  tokensBefore?: number
  tokensAfter?: number
  /** What the agent kept of the conversation it dropped. */
  summary?: string
  error?: string
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
 * absent for the main conversation. `at` is when it happened (epoch ms, to
 * within a second), on the events a pane dates; absent where the history
 * does not say.
 */
export type AcpEvent =
  /** A user message, echoed back so live history matches a replay.
   *  `steered` marks one added to a running turn, which it does not end.
   *  `continues` marks more of the message before it: a replay may send a
   *  message's blocks as separate chunks. */
  | { type: 'user'; seq: number; thread?: string; content: AcpContent[]; steered?: true; continues?: true; at?: number }
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
  /** The main conversation's context was compacted, or is being; carries
   *  its whole state. */
  | { type: 'compaction'; seq: number; compaction: AcpCompaction }
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
  | { type: 'woken'; seq: number; causes: AcpWake[]; at?: number }
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
  /**
   * Sent once per attach, and again when the agent restarts, before any
   * event: the conversation's last page, `page`, numbered for agent life
   * `life`. Replaces whatever the pane held.
   *
   * `history` marks a `tui` conversation followed through its tool's own
   * history (`/acp/observe`). Its events arrive a message at a time, as
   * the tool writes them, and it reports no turn boundaries, so `busy` is
   * always false and the agent's status is the snapshot's. The answer to
   * the pane's latest `subagent-transcript` request is sent again whenever
   * that transcript grows, and there is no `task-output`.
   */
  | {
    type: 'hello'
    conversationId: string
    busy: boolean
    queued: AcpQueuedPrompt[]
    page: number
    life?: string
    history?: true
    events: AcpEvent[]
  }
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
  /** The answer to a `subagent-transcript` request: the subagent's thread as
   *  its own transcript has it, or why it could not be read. */
  | { type: 'subagent-transcript'; subagentId: string; events?: AcpEventInit[]; error?: string }
  /**
   * The conversation's permission posture, sent after `hello` and whenever
   * it changes. Current state like `queue`, so it replaces what the pane
   * held. `available` lists the postures a pane may switch to, `current`
   * among them; it is empty when this conversation cannot be moved between
   * postures (opencode and pi carry theirs in launch config, or have none).
   */
  | { type: 'permission-mode'; current?: PermissionMode; available: PermissionMode[] }
  /**
   * The conversation's effort level (docs/effort-levels.md), sent after
   * `hello` and whenever it changes, replacing what the pane held.
   * `available` is the adapter's list for the current model, in the tool's
   * words with its display names; empty when the agent has no effort option.
   */
  | { type: 'effort'; current?: string; available: Array<{ value: string; name: string }> }

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
  /** Switch the session's posture to one the last `permission-mode` frame
   *  offered. A refusal comes back as an `error` event. */
  | { type: 'permission-mode'; mode: PermissionMode }
  /** Switch the session's effort to one the last `effort` frame offered. A
   *  refusal comes back as an `error` event. */
  | { type: 'effort'; effort: string }
  /** Stop a background task the record announced with `canStop`. Its
   *  `stopped` state comes back as a `task` event. */
  | { type: 'stop-task'; taskId: string }
  /** Read the end of a background task's output file. */
  | { type: 'task-output'; taskId: string }
  /** Read a subagent's thread from its own transcript, for one the record
   *  shows without it (a `session/load` replay leaves it out). */
  | { type: 'subagent-transcript'; subagentId: string }

