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
 */
export type AcpEvent =
  /** A user message, echoed back so live history matches a replay. */
  | { type: 'user'; seq: number; content: AcpContent[] }
  | { type: 'agent'; seq: number; content: AcpContent[] }
  /** Extended thinking. Panes render it collapsed. */
  | { type: 'thought'; seq: number; content: AcpContent[] }
  | { type: 'tool'; seq: number; call: AcpToolCall }
  | { type: 'plan'; seq: number; entries: AcpPlanEntry[] }
  /** The slash commands this session accepts, pushed on connect and whenever
   *  they change. */
  | { type: 'commands'; seq: number; commands: AcpCommand[] }
  /** The models this session offers and the one it runs, pushed by the
   *  handshake and again whenever the model changes. */
  | { type: 'models'; seq: number; current?: string; models: AcpModel[] }
  /** A prompt turn began, including one already running when the server
   *  reattached, which this pane did not start. */
  | { type: 'turn-start'; seq: number }
  /** A prompt turn finished; the agent is idle until the next prompt. */
  | { type: 'turn-end'; seq: number; stopReason: AcpStopReason }
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

/** Server → pane. */
export type AcpServerMessage =
  /** Sent once per attach, before any event: the recorded conversation,
   *  numbered from zero. Replaces whatever the pane held. */
  | { type: 'hello'; agentSessionId: string; busy: boolean; events: AcpEvent[] }
  | { type: 'event'; event: AcpEvent }
  /** The connection to the agent dropped or came back. acpd keeps the agent
   *  running meanwhile, so a reconnect resumes mid-turn. */
  | { type: 'health'; connected: boolean }

/** Pane → server. */
export type AcpClientMessage =
  /** A user message. `images` go to the agent as ACP image blocks after the
   *  text, so a message may be images alone; `data` is base64. */
  | { type: 'prompt'; text: string; images?: AcpImage[] }
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
