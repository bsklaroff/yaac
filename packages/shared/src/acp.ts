/**
 * The wire contract for an ACP conversation pane: what the server pushes
 * down `/acp/attach` and what the pane sends back.
 *
 * These are yaac's *normalized* shapes, not the Agent Client Protocol's own.
 * ACP is a live spec with optional capabilities and per-agent extensions; the
 * server's ACP client (packages/server/src/features/agents/acp) is the single
 * place that knows it, and it projects every `session/update` notification
 * into the small closed union below. A pane rendering these never has to know
 * which ACP revision the adapter in the container implements — and a spec
 * change lands in one translator instead of in React.
 *
 * The stream is append-only and sequenced: every event carries an increasing
 * `seq`, so a pane can order and de-duplicate the live events it appends.
 *
 * `seq` is scoped to one attach, not to the conversation. History does not
 * live in the server — it is the record acpd writes as it relays — so every
 * attach reads that record and numbers it from zero, then continues numbering
 * live events from there. A pane therefore *replaces* its list on `hello`
 * rather than merging into it: the record is authoritative and complete, so
 * what it says supersedes whatever the pane was holding.
 */

/** A piece of renderable content. Mirrors ACP's content blocks, minus the
 *  variants the container-resident agent never produces (it reads its own
 *  files rather than embedding resources for the client to resolve). */
export type AcpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

/**
 * A file edit, as the before/after texts the agent is writing.
 *
 * Kept structured rather than flattened into a text block, because it is the
 * one thing in the stream a pane can render *better* than prose: the same
 * syntax-highlighted diff the changes pane shows. The texts are a fragment of
 * the file, not the whole of it — an agent reports one hunk per block, with
 * context lines around the change — so a pane diffs the pair it is given,
 * never assumes it is looking at a complete file, and cannot honestly put
 * file line numbers next to it.
 *
 * `oldText` absent means the file is being created.
 */
export interface AcpDiff {
  type: 'diff'
  path: string
  oldText?: string
  newText: string
}

/** What a tool call can produce. A superset of `AcpContent`: a message is
 *  prose, but a tool call can also be an edit. */
export type AcpToolContent = AcpContent | AcpDiff

/** What a tool call is doing, as ACP reports it. */
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * ACP's tool-call kinds, kept verbatim so a pane can pick an icon without a
 * translation table. `other` is the catch-all an unknown kind collapses to.
 */
export type AcpToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'switch_mode' | 'other'

export interface AcpToolCall {
  /** Stable within the conversation: later updates to the same call reuse it,
   *  which is how a pane upgrades a `pending` row in place instead of
   *  appending a second one. */
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
 * One answer the agent offers for a permission ask, verbatim from ACP.
 *
 * `kind` is what a pane styles by — an `allow_*` is the affirmative and a
 * `reject_*` the refusal — and is absent when the agent labelled an option
 * with none, in which case the name is all there is to go on.
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

/**
 * Why a prompt turn ended. `end_turn` is the agent finishing normally;
 * everything else is a reason the pane should surface, since the user's
 * request was not fully served.
 */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

/**
 * One event in a conversation's stream.
 *
 * Text arrives in chunks exactly as the agent emits them — a pane appends
 * consecutive `agent` events into one bubble rather than the server buffering
 * whole messages, so output streams as it is generated.
 */
export type AcpEvent =
  /** A user message — echoed back by the agent so the pane renders the same
   *  history a `session/load` replay produces. */
  | { type: 'user'; seq: number; content: AcpContent[] }
  | { type: 'agent'; seq: number; content: AcpContent[] }
  /** Extended thinking. Panes render it collapsed. */
  | { type: 'thought'; seq: number; content: AcpContent[] }
  | { type: 'tool'; seq: number; call: AcpToolCall }
  | { type: 'plan'; seq: number; entries: AcpPlanEntry[] }
  /** The slash commands this session accepts, pushed on connect and whenever
   *  they change. */
  | { type: 'commands'; seq: number; commands: Array<{ name: string; description?: string }> }
  /**
   * A prompt turn began. A pane can usually infer this from the `user` message
   * it just sent, so this exists for the turns it cannot: one already running
   * when the server reattached to the agent, which nobody in this pane started.
   */
  | { type: 'turn-start'; seq: number }
  /** A prompt turn finished; the agent is idle until the next prompt. */
  | { type: 'turn-end'; seq: number; stopReason: AcpStopReason }
  /** The agent, adapter, or transport failed. Terminal for the turn, not for
   *  the conversation — the pane stays attached and the user can retry. */
  | { type: 'error'; seq: number; message: string }
  /**
   * The agent is asking permission to do something, and the turn is blocked
   * until someone answers. Under `bypass` the server answers it itself and the
   * pair renders as a decided line; under every other posture this is the
   * question the user is there to answer.
   *
   * `requestId` is the agent's own JSON-RPC request id, as a string. It is
   * what a pane sends back, and it is unique within one agent life — which is
   * also the scope of one record, so a replay can pair a request with its
   * answer without the server holding anything.
   */
  | {
    type: 'permission-request'
    seq: number
    requestId: string
    /** The call being asked about, when the agent named one. Rendered like
     *  any other tool row, since that is what it is about to become. */
    toolCall?: AcpToolCall
    options: AcpPermissionOption[]
  }
  /**
   * A permission ask was settled — by the user, by the `bypass` auto-answer,
   * or by a cancel. Pairs with the `permission-request` of the same
   * `requestId`, which is how a pane retires a pending card.
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
 * An event before the server stamps its sequence number — what a producer
 * builds. Distributive on purpose: a plain `Omit<AcpEvent, 'seq'>` collapses
 * the union to its common keys, so every variant's own payload would be
 * rejected.
 */
export type AcpEventInit = AcpEvent extends infer T
  ? T extends AcpEvent ? Omit<T, 'seq'> : never
  : never

/** Server → pane. */
export type AcpServerMessage =
  /**
   * Sent once per attach, before any event: the conversation as recorded,
   * numbered from zero. It supersedes whatever the pane held — see the header.
   */
  | { type: 'hello'; agentSessionId: string; busy: boolean; events: AcpEvent[] }
  | { type: 'event'; event: AcpEvent }
  /** The conversation's connection to the pod dropped or came back. The pane
   *  greys out rather than tearing down: acpd keeps the agent alive and keeps
   *  recording it, so a reconnect resumes mid-turn. */
  | { type: 'health'; connected: boolean }

/** Pane → server. */
export type AcpClientMessage =
  | { type: 'prompt'; text: string }
  /** Interrupt the running turn (ACP `session/cancel`). */
  | { type: 'cancel' }
  /**
   * The user's answer to a `permission-request`. `optionId` absent means they
   * dismissed the ask rather than choosing, which the agent is told as
   * `cancelled`.
   *
   * Answering is idempotent and late answers are harmless: the server drops
   * one for an ask it has already settled, so two panes racing on the same
   * card cannot send the agent two replies.
   */
  | { type: 'permission'; requestId: string; optionId?: string }

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
