/**
 * One live ACP conversation: the server's side of the JSON-RPC dialogue with
 * an agent running under acpd in a workspace.
 *
 * An `AcpConversation` holds what must survive a closed tab or a dropped
 * connection: the ACP session id (minted by `session/new`, reused on
 * reconnect) and whether the agent is working (the running/waiting
 * status). Content lives in acpd's record, which panes tail. Reconnect
 * policy belongs to the caller (`acp-driver.ts`), as with the tmux watcher.
 *
 * ## Working
 *
 * Two facts make up "working". `busy` is exact but partial: one of our
 * `session/prompt` requests is unanswered. The adapter's own state report
 * (`agentRunningReport`; opencode sends none) also covers turns the agent
 * starts by itself, such as a background task finishing, a scheduled
 * wakeup, or a steer codex turns into a turn of its own. Status, the pane's
 * turn boundaries and steering follow either; only `busy` holds back the
 * queue, since most adapters take a prompt while running on their own
 * (pi's is the exception, see `holdsPrompts`).
 *
 * Between turns, background work the agent started (`backgroundWorkReport`,
 * claude only) makes the status `background` rather than `waiting`.
 *
 * ## Reconnect
 *
 * acpd keeps the agent alive across detaches, so a reconnect may land
 * mid-turn. acpd's `_acpd/hello` carries `firstAttach` because:
 *
 *  1. The handshake (`initialize`, `session/new`) runs once per agent
 *     process. On a reattach this class skips it and consumes notifications
 *     for the session id it already holds.
 *  2. ACP has no way to ask whether a turn is running (turn state is tied
 *     to your own unanswered `session/prompt`). A reattach rebuilds it from
 *     the record (`recoverInFlight`), which shows whether the last prompt
 *     was answered and what state the adapter last reported.
 *
 * Recovery reads a file, so newer signals can beat it: a prompt sent after
 * the reattach, the old turn's reply arriving as an orphan response, or a
 * live state report. Whichever classifies first wins, so a stale `true`
 * from the scan cannot pin a finished conversation busy.
 */

import { randomUUID } from 'node:crypto'
import { JsonRpcCallError, JsonRpcPeer, type JsonRpcTransport } from './acp-jsonrpc'
import {
  ACP,
  ACPD,
  ACP_PROTOCOL_VERSION,
  acpModeOffered,
  asRecord,
  chooseAllowOption,
  clientCapabilities,
  agentRunningReport,
  backgroundWorkReport,
  isWorkUpdate,
  permissionReply,
  sessionModeId,
  sessionModel,
  toStopReason,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpConfigOption,
  type AcpLoadSessionResult,
  type AcpSessionModes,
} from './acp-protocol'
import { acpPermissionModeFor, type AcpAdapterProfile } from './acp-adapters'
import type { AcpInFlight } from './acp-log'
import { serverLog } from '#log'
import type { AcpEventInit, AcpImage, AcpQueuedPrompt, AcpServerMessage, AcpStopReason } from '@yaac/shared/acp'
import { PERMISSION_MODES, type AgentStatus, type PermissionMode } from '@yaac/shared/types'

/**
 * How long the end of background work waits before the status drops to
 * `waiting`. claude reports a finished task gone just before its
 * notification wakes the agent, and without this grace the moment between
 * would start a waiting spell, which chimes.
 */
const BACKGROUND_SETTLE_MS = 3000

export interface AcpConversationDeps {
  /** The pod-side transport, already dialed. */
  transport: JsonRpcTransport
  /** The agent's working directory. */
  cwd: string
  /**
   * The ACP session id to resume, when one is already recorded (after a
   * restart). Absent for a new conversation.
   */
  resumeSessionId?: string
  /** Event tap for the owning connection. Panes use `subscribe` instead. */
  onEvent?: (event: AcpEventInit) => void
  /** Fired when the session id is first known, so the caller can record it.
   *  Not fired on a resume. */
  onSessionId: (agentSessionId: string) => void
  /**
   * `status` changed, including its first resolution out of undefined.
   * Read the getter: a turn parked on a permission ask is working but
   * `asking`.
   */
  onStatus: () => void
  /**
   * Whether a prompt turn was in flight when the record was last written
   * (`readAcpInFlight`). Used once on a reattach, the only case where a turn
   * this connection did not start can be running. Absent or throwing means
   * idle.
   */
  recoverInFlight?: () => Promise<AcpInFlight>
  /**
   * Permission asks the agent was still blocked on per the record
   * (`readAcpPendingPermissions`). Used on a reattach, since the ask went to
   * a connection that is gone and nothing replays it.
   */
  recoverPendingPermissions?: () => Promise<Array<string | number>>
  /**
   * The conversation's permission posture. An accessor because a restart
   * can rewrite the row while the conversation lives. `undefined` means not
   * known yet (row missing or unreadable), which differs from the accessor
   * being absent; see `permissionMode()`.
   */
  permissionMode?: () => PermissionMode | undefined
  /**
   * What the adapter can be told, and how. Absent (tests driving the
   * protocol directly) means tell it nothing: no mode, no model, leaving the
   * adapter's strict default.
   */
  profile?: Pick<AcpAdapterProfile, 'modeIds' | 'readsAs' | 'forwardAsksUnderBypass' | 'steers'
    | 'sessionMeta' | 'capabilitiesMeta' | 'infersRunStart' | 'refusesPromptMidRun'>
  /**
   * The model to send, for adapters that only accept one over the protocol.
   * Sent once after `session/new`, never after `session/load` (the user may
   * have changed the model since).
   */
  launchModel?: string
  /**
   * The session's model changed or was first learned. Fires on the switch
   * (`config_option_update`), only when the value changes. `name` is the
   * adapter's display name, when known (see `sessionModel`).
   */
  onModel?: (model: string, name: string | undefined) => void
  /**
   * The session moved to another mode (e.g. entered plan mode), as the
   * adapter's mode id. Fires only on change; on a reattach, also with the
   * mode the record shows.
   */
  onModeId?: (modeId: string) => void
  /**
   * The mode the record last shows (`readAcpModeId`). Used on a reattach,
   * which runs no handshake, since the session may have changed mode while
   * disconnected.
   */
  recoverModeId?: () => Promise<string | undefined>
  /**
   * The last `bytes` of a file in the workspace, for showing a background
   * task's output (`readTaskOutput`). Absent means unreadable.
   */
  tailFile?: (path: string, bytes: number) => Promise<string>
  onDown: (reason: string) => void
  /** Messages the conversation this one replaces had queued (`takeQueue`),
   *  sent once this one knows no turn is running. */
  queue?: QueuedTurn[]
  log?: (msg: string) => void
}

/** The posture state a `permission-mode` frame carries. */
export type AcpPermissionModes = Omit<Extract<AcpServerMessage, { type: 'permission-mode' }>, 'type'>

/** A queued message with what is needed to send it and settle its caller. */
export interface QueuedTurn extends AcpQueuedPrompt {
  blocks: Array<Record<string, string>>
  resolve: () => void
  reject: (err: unknown) => void
}

/** How much of a task's output a pane is shown: its end, like a TUI's
 *  task view. */
const TASK_OUTPUT_BYTES = 64 * 1024

export class AcpConversation {
  private readonly peer: JsonRpcPeer
  private readonly log: (msg: string) => void
  private readonly subscribers = new Set<(event: AcpEventInit) => unknown>()
  /** Settles once every subscriber has delivered the last event; see
   *  `subscribe`. */
  private delivered: Promise<unknown> = Promise.resolve()
  private readonly closeSubscribers = new Set<() => void>()
  private sessionId: string | undefined
  /** One of our prompts is unanswered; see "Working" above. */
  private busy = false
  /** The adapter's last report of its own state, undefined until one
   *  arrives (or always, for adapters that send none). */
  private agentRunning: boolean | undefined
  /** The adapter's last report of live background work
   *  (`backgroundWorkReport`), undefined until one arrives. */
  private backgroundWork: boolean | undefined
  /** Pending drop of `backgroundWork` to false; see `setBackgroundWork`. */
  private backgroundSettle: NodeJS.Timeout | undefined
  /** How the work in progress ended, for its `turn-end`: the last prompt
   *  reply's stop reason, which can precede the adapter going idle. */
  private stopReason: AcpStopReason = 'end_turn'
  /**
   * Whether `busy` is known yet. A fresh attach may have landed on a working
   * agent, so status stays undefined until the handshake or recovery
   * settles it.
   */
  private statusKnown = false
  /**
   * Messages waiting for the running turn to end. Adapters assume one turn
   * at a time, so a message one cannot steer into the turn waits here;
   * otherwise the first reply would end the turn while the second still
   * streams. Panes show the queue and may drop entries (`unqueue`).
   */
  private readonly queue: QueuedTurn[] = []
  private readonly queueSubscribers = new Set<(queued: AcpQueuedPrompt[]) => void>()
  private readonly permissionModeSubscribers = new Set<(modes: AcpPermissionModes) => void>()
  /** Whether `drain` is running, which is also when a new message must wait. */
  private draining = false
  /** Tail of message routing; see `prompt`. */
  private intake: Promise<unknown> = Promise.resolve()
  /** Whether panes were last told of a non-empty queue. */
  private queueShown = false
  /** Woken on every status change; see `whenStatus`. */
  private statusWaiters: Array<() => void> = []
  private ready = false
  /**
   * acpd's greeting is always the first line. A later one is ignored: acpd
   * passes adapter output through verbatim, so the agent could forge a
   * `firstAttach:true` and trigger a second handshake.
   */
  private helloSeen = false
  private readyWaiters: Array<(err?: Error) => void> = []
  private closed = false
  /**
   * Permission asks held open by this connection, by the agent's request id.
   * Resolving one answers the request and unblocks the agent.
   */
  private readonly pendingPermissions = new Map<string, (result: unknown) => void>()
  /**
   * Asks already answered, so later answers are dropped. Two panes can show
   * the same card, and after a reconnect an answer takes the `respondTo`
   * path, which has no pending entry to consume.
   */
  private readonly answeredPermissions = new Set<string>()
  /**
   * Asks recovered from the record on a reattach: still outstanding at the
   * agent, with no served request here. Values are the id exactly as the
   * agent wrote it, which the reply must carry.
   */
  private readonly recoveredPermissions = new Map<string, string | number>()
  /**
   * Answers that arrived before `recover()` identified their ask (a pane
   * clicking a recovered card mid-read). Applied once recovery finds it.
   */
  private readonly deferredAnswers = new Map<string, unknown>()
  /**
   * Notices for panes that are not attached yet. The handshake's reports
   * (from `applyPermissionMode` and `applyLaunchModel`) happen before any
   * pane can exist, and they say the conversation is not running as
   * requested. Keyed by topic so a later success clears the notice; every
   * attaching pane gets them (see `attachAcp`).
   */
  private readonly notices = new Map<'mode' | 'model', AcpEventInit>()
  /** The session's modes, per `session/new` or `session/load`. */
  private sessionModes: AcpSessionModes | undefined
  /** The same facts as config options; opencode v2 sends only these. */
  private sessionConfig: AcpConfigOption[] | undefined
  /** The model the session last reported; see `onModel`. Unknown after a
   *  reattach until the adapter next reports it. */
  private currentModel: string | undefined
  /** The posture a first attach launched in; see `posture()`. Never set on
   *  a reattach. */
  private launchPosture: PermissionMode | undefined
  /** Settles once a reattach has read its mode back (`recoverMode`). */
  private postureRecovery: Promise<void> | undefined

  constructor(private readonly deps: AcpConversationDeps) {
    this.log = deps.log ?? serverLog
    this.sessionId = deps.resumeSessionId
    this.peer = new JsonRpcPeer(deps.transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onOrphanResponse: () => this.endTurn('end_turn'),
      onClose: (reason) => this.onClose(reason),
    })
    if (deps.queue !== undefined && deps.queue.length > 0) {
      this.queue.push(...deps.queue)
      this.queueShown = true
      void this.drain()
    }
  }

  /** The ACP session id, once the handshake has produced one. */
  get agentSessionId(): string | undefined {
    return this.sessionId
  }

  /** Whether the agent is working, by either signal ("Working" above). */
  get isBusy(): boolean {
    return this.busy || this.agentRunning === true
  }

  /**
   * The conversation's status, or undefined while unclassified (mid-
   * handshake, or reading the record after a reattach). Callers must skip
   * undefined rather than default it: reporting `waiting` for a working
   * agent is the bug recovery exists to prevent.
   */
  get status(): AgentStatus | undefined {
    if (!this.statusKnown) return undefined
    // A turn blocked on an ask is busy but stopped on the user, which is
    // exactly when the sidebar, chime and tray badge should say so.
    if (this.isAwaitingPermission) return 'asking'
    if (this.isBusy) return 'running'
    return this.backgroundWork === true ? 'background' : 'waiting'
  }

  /** Whether the agent is parked on an ask nobody has answered. */
  get isAwaitingPermission(): boolean {
    return this.pendingPermissions.size > 0 || this.recoveredPermissions.size > 0
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Watch the live stream; returns the unsubscribe. Events are unsequenced:
   * each attach numbers its own replay from zero, so only the subscriber
   * knows its numbering. Several panes may subscribe.
   *
   * A subscriber may return a promise that settles once it has delivered
   * the event. The queue waits for that before starting the next turn, so a
   * pane gets a turn's end before the queued message that follows it.
   */
  subscribe(fn: (event: AcpEventInit) => unknown): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /** The messages waiting for the running turn to end, oldest first. */
  get queuedPrompts(): AcpQueuedPrompt[] {
    return this.queue.map(({ id, text, images }) => ({ id, text, images }))
  }

  /** Watch the queue; returns the unsubscribe. */
  onQueue(fn: (queued: AcpQueuedPrompt[]) => void): () => void {
    this.queueSubscribers.add(fn)
    return () => this.queueSubscribers.delete(fn)
  }

  private publishQueue(): void {
    const queued = this.queuedPrompts
    if (queued.length === 0 && !this.queueShown) return
    this.queueShown = queued.length > 0
    for (const fn of this.queueSubscribers) fn(queued)
  }

  /**
   * The posture this conversation is in and the ones a pane may switch it
   * to: those with a session mode the adapter offers. When the offer is not
   * known, every mapped posture is listed and the adapter's refusal reports
   * the rest. A reattach runs no handshake, and every connection after a
   * server restart is a reattach, so the unfiltered list is the usual case.
   * The list is empty unless it holds the current posture and another, since
   * a pane could otherwise leave a posture it can never return to (opencode
   * maps only `plan` to a mode).
   */
  get permissionModes(): AcpPermissionModes {
    const current = this.posture() ?? this.permissionMode()
    const state = this.sessionState()
    const known = state.modes?.availableModes !== undefined
      || state.configOptions?.some((o) => o.id === 'mode') === true
    const modeIds = this.deps.profile?.modeIds ?? {}
    const available = PERMISSION_MODES.filter((m) => {
      const modeId = modeIds[m]
      return modeId !== undefined && (!known || acpModeOffered(state, modeId))
    })
    return {
      ...(current !== undefined ? { current } : {}),
      available: current !== undefined && available.includes(current) && available.length > 1 ? available : [],
    }
  }

  /** Watch `permissionModes`; returns the unsubscribe. */
  onPermissionModes(fn: (modes: AcpPermissionModes) => void): () => void {
    this.permissionModeSubscribers.add(fn)
    return () => this.permissionModeSubscribers.delete(fn)
  }

  private publishPermissionModes(): void {
    const modes = this.permissionModes
    for (const fn of this.permissionModeSubscribers) fn(modes)
  }

  /** Watch for the conversation closing, so an attached pane can show it.
   *  Returns the unsubscribe. */
  onClosed(fn: () => void): () => void {
    if (this.closed) {
      fn()
      return () => { /* already fired */ }
    }
    this.closeSubscribers.add(fn)
    return () => this.closeSubscribers.delete(fn)
  }

  /**
   * Publish a turn boundary or an error: the only live events, since the
   * record cannot carry them. Content never comes through here (see
   * `onNotification`), so these never duplicate the tail.
   */
  private emit(event: AcpEventInit): void {
    this.deps.onEvent?.(event)
    this.delivered = Promise.allSettled([...this.subscribers].map((fn) => Promise.resolve(fn(event))))
  }

  /**
   * Settle `busy`. The first call always classifies the conversation, even
   * for the initial `false`, since "idle" and "not classified yet" differ.
   */
  private setBusy(busy: boolean): void {
    if (this.statusKnown && this.busy === busy) return
    this.changeWork(() => {
      this.statusKnown = true
      this.busy = busy
    })
  }

  private setAgentRunning(running: boolean | undefined): void {
    if (running === this.agentRunning) return
    this.changeWork(() => { this.agentRunning = running })
  }

  /**
   * Follow a report of background work. Its end settles late while idle
   * (`BACKGROUND_SETTLE_MS`), or at once if the agent wakes first
   * (`changeWork`).
   */
  private setBackgroundWork(live: boolean | undefined, { settle = true } = {}): void {
    clearTimeout(this.backgroundSettle)
    this.backgroundSettle = undefined
    if (live === this.backgroundWork) return
    if (settle && live === false && !this.isBusy && !this.closed) {
      this.backgroundSettle = setTimeout(() => this.setBackgroundWork(false, { settle: false }), BACKGROUND_SETTLE_MS)
      return
    }
    this.changeWork(() => { this.backgroundWork = live })
  }

  /**
   * Apply a change to either working signal and publish its effects. The
   * events here are the pane's only turn boundaries, including for recovered
   * turns: panes infer nothing from content, since a replay's `user`
   * messages have no closing boundary (docs/agent-modes.md).
   */
  private changeWork(change: () => void): void {
    const wasWorking = this.isBusy
    const wasStatus = this.status
    change()
    if (this.isBusy && this.backgroundSettle !== undefined) {
      clearTimeout(this.backgroundSettle)
      this.backgroundSettle = undefined
      this.backgroundWork = false
    }
    if (this.isBusy !== wasWorking) {
      if (this.isBusy) {
        this.stopReason = 'end_turn'
        this.emit({ type: 'turn-start' })
      } else {
        this.emit({ type: 'turn-end', stopReason: this.stopReason })
      }
    }
    if (this.status !== wasStatus) this.deps.onStatus()
    this.wakeStatusWaiters()
  }

  /**
   * Whether the queue must wait: behind a turn of ours this connection did
   * not start (a recovered one), or, for an adapter that cannot take a
   * message mid-run (`AcpAdapterProfile.refusesPromptMidRun`), behind a run
   * the agent started itself.
   */
  private get holdsPrompts(): boolean {
    return this.busy || (this.deps.profile?.refusesPromptMidRun === true && this.agentRunning === true)
  }

  private wakeStatusWaiters(): void {
    for (const fn of this.statusWaiters) fn()
    this.statusWaiters = []
  }

  /** Resolve once `cond` holds after a status change, or the conversation
   *  closes. */
  private async whenStatus(cond: () => boolean): Promise<void> {
    while (!cond() && !this.closed) await new Promise<void>((resolve) => this.statusWaiters.push(resolve))
  }

  /**
   * Resolve once nothing holds the queue (`holdsPrompts`). Own turns run
   * one at a time in `drain`, so this waits out an unclassified
   * conversation, a recovered turn, which ends via the orphan reply, the
   * agent exiting, or the conversation closing, and a run the agent started
   * that `holdsPrompts` waits for, which ends with its idle report or a Stop.
   *
   * A turn recovered from a torn record (its reply already lost) never
   * ends, so a queue behind it holds until the workspace restarts
   * (docs/agent-modes.md, "Where status can mislead"). A timer could not
   * tell that from a long-running turn.
   */
  private whenIdle(): Promise<void> {
    return this.whenStatus(() => this.statusKnown && !this.holdsPrompts)
  }

  private endTurn(stopReason: Parameters<typeof toStopReason>[0]): void {
    this.stopReason = toStopReason(stopReason)
    // Unconditional, so an orphan reply or agent exit classifies the
    // conversation even before recovery answers.
    this.setBusy(false)
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case ACPD.hello: {
        if (this.helloSeen) return
        this.helloSeen = true
        const firstAttach = (params as { firstAttach?: boolean } | undefined)?.firstAttach ?? true
        void this.handshake(firstAttach)
        return
      }
      case ACPD.exit: {
        const code = (params as { code?: number } | undefined)?.code
        // The asking process is gone; release parked asks so the
        // conversation does not stay `waiting`.
        this.cancelPendingPermissions()
        this.endTurn('cancelled')
        this.setAgentRunning(undefined)
        this.setBackgroundWork(undefined, { settle: false })
        this.emit({ type: 'error', message: `the agent process exited (code ${code ?? '?'})` })
        return
      }
      case ACP.sessionUpdate: {
        // Content is ignored here; panes get it only from acpd's record (see
        // attachAcp). Session state is tracked: a model switch arrives as
        // `config_option_update`, a mode change as `current_mode_update` or a
        // `config_option_update` for the `mode` option.
        const update = asRecord(asRecord(params)?.update)
        if (update?.sessionUpdate === 'config_option_update') this.setModel(sessionModel(update))
        if (update !== undefined) this.setModeId(sessionModeId(update))
        this.noteAgentState(method, params)
        return
      }
      default:
        this.noteAgentState(method, params)
        return
    }
  }

  /**
   * Follow the adapter's report of its own state. Inferred starts wait for
   * `ready`: `session/load` replays history as updates before then.
   */
  private noteAgentState(method: string, params: unknown): void {
    const background = backgroundWorkReport(method, params)
    if (background !== undefined) this.setBackgroundWork(background)
    const running = agentRunningReport(method, params)
    if (running !== undefined) this.setAgentRunning(running)
    else if (method === ACP.sessionUpdate && this.deps.profile?.infersRunStart === true
      && this.ready && !this.isBusy && isWorkUpdate(params)) {
      this.setAgentRunning(true)
    }
  }

  /**
   * Serve a request from the agent.
   *
   * Under `bypass` a permission ask is answered at once. Otherwise it is
   * parked with no timeout until the user decides: answering for them after
   * a delay is the auto-approval the posture refuses. A decision, cancel,
   * agent exit or close releases it.
   */
  private onRequest(method: string, params: unknown, id: string | number): Promise<unknown> {
    if (method === ACP.requestPermission) {
      // Wait for a reattach to recover its posture first.
      const recovering = this.postureRecovery
      if (recovering !== undefined) return recovering.then(() => this.onRequest(method, params, id))
      // pi's asks are extension questions, not permission prompts, so they
      // are forwarded even under `bypass`.
      if (this.posture() === 'bypass' && !this.forwardsAsksUnderBypass()) {
        // Grant (see chooseAllowOption); an ask with no option is refused.
        return Promise.resolve(permissionReply(chooseAllowOption(params)))
      }
      const requestId = String(id)
      this.log(`[server] acp: awaiting a permission decision on ${requestId}`)
      return new Promise<unknown>((resolve) => {
        this.pendingPermissions.set(requestId, resolve)
        // If the record scan and live delivery raced, keep the served one.
        this.recoveredPermissions.delete(requestId)
        this.publishPermissionPending()
      })
    }
    // fs/* and terminal/* are declined in `clientCapabilities`.
    throw new JsonRpcCallError({ code: -32601, message: `yaac does not serve ${method}` })
  }

  /**
   * The posture to answer by, or undefined when not known yet (row missing
   * or unreadable). Unknown is not treated as `bypass`: parking an ask that
   * could have been granted costs a click, while wrongly granting one is
   * silent and irreversible. With no accessor at all (tests), `bypass`.
   */
  private permissionMode(): PermissionMode | undefined {
    if (this.deps.permissionMode === undefined) return 'bypass'
    return this.deps.permissionMode()
  }

  /**
   * The posture this conversation answers asks by: the one its adapter's
   * current mode maps to. Per conversation, since each adapter holds its own
   * mode and the workspace row may follow another one. When the mode maps to
   * no posture (opencode agents, pi thinking levels), the launch posture is
   * used; a reattach has none, so every ask is forwarded.
   */
  private posture(): PermissionMode | undefined {
    const modeId = this.currentModeId()
    const mode = modeId === undefined || this.deps.profile === undefined
      ? undefined
      : acpPermissionModeFor(this.deps.profile, modeId)
    return mode ?? this.launchPosture
  }

  /** Follow a mode the adapter says the session moved to. */
  private setModeId(modeId: string | undefined): void {
    if (modeId === undefined || modeId === this.currentModeId()) return
    this.sessionModes = { ...this.sessionModes, currentModeId: modeId }
    this.deps.onModeId?.(modeId)
    this.publishPermissionModes()
  }

  /**
   * Recover a reattached session's mode from its record, since it may have
   * changed while disconnected. A mode change seen during the read is newer
   * and wins.
   */
  private async recoverMode(): Promise<void> {
    try {
      const recorded = await this.deps.recoverModeId?.()
      if (this.currentModeId() === undefined) this.setModeId(recorded)
    } catch (err) {
      this.log(`[server] acp: could not recover the session mode: ${String(err)}`)
    }
  }

  private setModel(model: { id: string; name?: string } | undefined): void {
    if (model === undefined || model.id === this.currentModel) return
    this.currentModel = model.id
    this.deps.onModel?.(model.id, model.name)
  }

  /** The session's modes as the handshake announced them, in both shapes. */
  private sessionState(): { modes?: AcpSessionModes; configOptions?: AcpConfigOption[] } {
    return {
      ...(this.sessionModes !== undefined ? { modes: this.sessionModes } : {}),
      ...(this.sessionConfig !== undefined ? { configOptions: this.sessionConfig } : {}),
    }
  }

  /** The session's current mode, from whichever shape the adapter uses. */
  private currentModeId(): string | undefined {
    if (this.sessionModes?.currentModeId !== undefined) return this.sessionModes.currentModeId
    const mode = this.sessionConfig?.find((o) => o.id === 'mode')?.currentValue
    return typeof mode === 'string' ? mode : undefined
  }

  /** Whether this adapter's asks reach the user even under `bypass`. */
  private forwardsAsksUnderBypass(): boolean {
    return this.deps.profile?.forwardAsksUnderBypass === true
  }

  /** Republish status, since a pending ask changes it without a turn
   *  boundary. */
  private publishPermissionPending(): void {
    this.deps.onStatus()
  }

  /**
   * Settle a permission ask with the user's decision; no `optionId` means
   * dismissed, sent as `cancelled`.
   *
   * An ask can outlive the connection that received it (relay drop, server
   * restart). Then the reply is written against the agent's own request id,
   * so a recovered card can still be answered without restarting the
   * workspace.
   */
  answerPermission(requestId: string, optionId?: string): void {
    if (this.answeredPermissions.has(requestId)) {
      this.log(`[server] acp: permission ${requestId} already answered — ignoring`)
      return
    }
    this.settlePermission(requestId, permissionReply(optionId))
  }

  /**
   * Send an answer by whichever route this connection has, and republish
   * status.
   *
   * An answer matching neither map is held, not dropped and not marked
   * answered: a reattaching pane replays pending cards from the record
   * before `recover()` has identified them, and marking it answered would
   * make `recover()` skip it, leaving the agent blocked.
   */
  private settlePermission(requestId: string, result: unknown): void {
    const resolve = this.pendingPermissions.get(requestId)
    if (resolve !== undefined) {
      this.pendingPermissions.delete(requestId)
      this.answeredPermissions.add(requestId)
      resolve(result)
      this.publishPermissionPending()
      return
    }
    const recovered = this.recoveredPermissions.get(requestId)
    if (recovered !== undefined) {
      this.recoveredPermissions.delete(requestId)
      this.answeredPermissions.add(requestId)
      if (!this.closed) {
        this.log(`[server] acp: answering permission ${requestId} across a reconnect`)
        // Use the id exactly as the agent wrote it: JSON-RPC matches ids by
        // value and type, so `42` answered as `"42"` would never pair.
        this.peer.respondTo(recovered, result)
      }
      this.publishPermissionPending()
      return
    }
    // Unknown here: hold it for a recovery that may still name it.
    this.log(`[server] acp: holding an answer for the unrecognized permission ${requestId}`)
    this.deferredAnswers.set(requestId, result)
  }

  /** Apply answers that arrived before the ask they belong to was known. */
  private applyDeferredAnswers(): void {
    for (const [requestId, result] of [...this.deferredAnswers]) {
      if (!this.recoveredPermissions.has(requestId)) continue
      this.deferredAnswers.delete(requestId)
      this.log(`[server] acp: applying the held answer for permission ${requestId}`)
      this.settlePermission(requestId, result)
    }
  }

  /**
   * Abandon every open ask (turn cancelled, agent gone, or connection
   * closing). ACP expects a cancelling client to resolve outstanding
   * permission requests, and an unresolved one strands a request
   * `JsonRpcPeer` would never reply to.
   */
  private cancelPendingPermissions(): void {
    // Held answers go too, so one can never apply to a later ask that
    // reuses the id.
    this.deferredAnswers.clear()
    if (!this.isAwaitingPermission) return
    for (const [requestId, resolve] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId)
      this.answeredPermissions.add(requestId)
      resolve(permissionReply(undefined))
    }
    // Recovered asks have no promise here, and answering over the wire
    // would answer for the user; just drop them.
    this.recoveredPermissions.clear()
    this.publishPermissionPending()
  }

  /**
   * Make the conversation ready for `prompt()`: the full ACP handshake on a
   * first attach, nothing on a reattach (re-running `initialize` against a
   * live agent is undefined).
   */
  private async handshake(firstAttach: boolean): Promise<void> {
    try {
      if (!firstAttach) {
        if (this.sessionId === undefined) {
          throw new Error('reattached to a live agent with no recorded session id')
        }
        this.log(`[server] acp: reattached to session ${this.sessionId}`)
        // Ready before recovery; a prompt still waits for it to classify
        // the turn (`prompt`), and asks for the posture to be recovered.
        this.postureRecovery = this.recoverMode().finally(() => { this.postureRecovery = undefined })
        this.markReady()
        await this.postureRecovery
        await this.recover()
        return
      }

      const init = await this.peer.request<AcpInitializeResult>(ACP.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities(this.deps.profile?.capabilitiesMeta),
      })

      const canLoad = init.agentCapabilities?.loadSession === true
      if (this.sessionId !== undefined && canLoad) {
        // Most adapters replay the conversation as `session/update`
        // notifications; opencode replays nothing, so acpd keeps its record
        // (`--append`). Panes read the record either way.
        const loaded = await this.peer.request<AcpLoadSessionResult>(ACP.sessionLoad, {
          sessionId: this.sessionId,
          cwd: this.deps.cwd,
          mcpServers: [],
          ...this.sessionMeta(),
        })
        this.sessionModes = loaded.modes
        this.sessionConfig = loaded.configOptions
        this.setModel(sessionModel(loaded))
      } else {
        if (this.sessionId !== undefined) {
          this.log('[server] acp: adapter cannot load sessions — starting a fresh conversation')
        }
        const created = await this.peer.request<AcpNewSessionResult>(ACP.sessionNew, {
          cwd: this.deps.cwd,
          mcpServers: [],
          ...this.sessionMeta(),
        })
        if (typeof created.sessionId !== 'string' || created.sessionId === '') {
          throw new Error('session/new returned no session id')
        }
        this.sessionId = created.sessionId
        this.sessionModes = created.modes
        this.sessionConfig = created.configOptions
        this.deps.onSessionId(created.sessionId)
        this.setModel(sessionModel(created))
        await this.applyLaunchModel()
      }
      await this.applyPermissionMode()
      this.markReady()
      // A fresh agent process has nothing in flight; classify it now.
      this.setBusy(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[server] acp: handshake failed: ${message}`)
      this.emit({ type: 'error', message: `ACP handshake failed: ${message}` })
      this.deps.onDown(`handshake failed: ${message}`)
    }
  }

  private sessionMeta(): { _meta?: Record<string, unknown> } {
    const meta = this.deps.profile?.sessionMeta
    return meta === undefined ? {} : { _meta: meta }
  }

  /**
   * Put the session in its posture's mode. Forwarding asks decides who
   * answers; the mode decides which questions are asked at all. Without it
   * `accept-edits` would prompt for every edit (the adapter default asks
   * about everything).
   *
   * First attach only. On a reattach the adapter may be in a mode the user
   * chose since (accepting "auto-accept edits" when leaving plan mode moves
   * it to `acceptEdits`), and re-asserting would undo that on every relay
   * hiccup. The row follows the user's moves instead.
   *
   * An unadvertised mode is reported, not thrown: create already refuses
   * postures a tool cannot express, so this means the session clamped one
   * (`auto` without a classifier, `bypassPermissions` as root outside a
   * sandbox), and running in the default beats losing the conversation.
   */
  private async applyPermissionMode(): Promise<void> {
    // Read once: the row follows every conversation in the workspace.
    this.launchPosture = this.permissionMode()
    if (this.sessionId === undefined) return
    const mode = this.launchPosture
    if (mode === undefined) {
      // The adapter default is the strict one, and every ask is forwarded.
      this.log('[server] acp: no posture known for this workspace'
        + ' — leaving the session in the adapter default and forwarding its asks')
      return
    }
    const modeId = this.deps.profile?.modeIds[mode]
    if (modeId === undefined) {
      // No mode for this posture by design (opencode carries it in launch
      // env; pi has no permission system), or no adapter profile (tests).
      return
    }
    if (this.currentModeId() === modeId) return
    if (!acpModeOffered(this.sessionState(), modeId)) {
      this.reportModeNotSet(mode, modeId, 'offers no such mode')
      return
    }
    try {
      await this.peer.request(ACP.sessionSetMode, { sessionId: this.sessionId, modeId })
      this.sessionModes = { ...this.sessionModes, currentModeId: modeId }
      this.notices.delete('mode')
      this.log(`[server] acp: session mode set to ${modeId} for "${mode}"`)
    } catch (err) {
      // Report it in the pane, not just the log: an adapter default is not
      // always stricter (codex-acp's `agent` lets a reviewer model approve
      // most actions).
      this.reportModeNotSet(mode, modeId, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Tell the pane and the log that the conversation is not in its requested
   * posture, stating only the mode it is actually in (what happens to asks
   * varies; codex's fallback has a reviewer model answer most). That mode is
   * also reported upward so the row reflects it.
   */
  private reportModeNotSet(mode: PermissionMode, modeId: string, why: string): void {
    const current = this.currentModeId()
    const message = `The agent would not switch to "${modeId}" for the ${mode} posture`
      + ` (${why}) — running in ${current ?? 'its own default'} instead.`
    this.log(`[server] acp: ${message}`)
    this.notice('mode', { type: 'error', message })
    if (current !== undefined) this.deps.onModeId?.(current)
  }

  /** Emit now and keep it for later attachers until it no longer applies. */
  private notice(about: 'mode' | 'model', event: AcpEventInit): void {
    this.notices.set(about, event)
    this.emit(event)
  }

  /**
   * Notices an attaching pane has missed; sent after its `hello`, so a pane
   * opened at any time sees them.
   */
  get standingNotices(): AcpEventInit[] {
    return [...this.notices.values()]
  }

  /**
   * Set the model on a new session, for adapters that take it no other way.
   * Only after `session/new`: after `session/load` the adapter holds a model
   * the user may have changed, and re-asserting would undo it.
   *
   * A refusal (no credential for the provider, a retired id) is reported in
   * the pane and survived, since silently running another model than
   * `--model` asked for could surprise the user's bill.
   */
  private async applyLaunchModel(): Promise<void> {
    const model = this.deps.launchModel
    if (model === undefined || this.sessionId === undefined) return
    try {
      await this.requestModel(model)
      this.notices.delete('model')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const message = `The agent would not switch to the model "${model}"`
        + ` — running its own default instead (${detail}).`
      this.log(`[server] acp: ${message}`)
      this.notice('model', { type: 'error', message })
    }
  }

  /** Switch the model as the user asked from the pane (`/model`). A refusal
   *  is shown there, and the session keeps the model it had. */
  async switchModel(model: string): Promise<void> {
    try {
      await this.whenReady(120_000)
      await this.requestModel(model)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message: `The agent would not switch to the model "${model}" (${detail}).` })
    }
  }

  /**
   * Switch the posture as the user asked from the pane. The new mode is
   * reported upward like one the adapter chose (`onModeId`), so the row
   * follows it. A refusal is shown in the pane, and the session keeps the
   * mode it had.
   */
  async switchPermissionMode(mode: PermissionMode): Promise<void> {
    const modeId = this.deps.profile?.modeIds[mode]
    try {
      if (modeId === undefined) throw new Error('no session mode for it')
      await this.whenReady(120_000)
      if (this.sessionId === undefined) throw new Error('no ACP session')
      await this.peer.request(ACP.sessionSetMode, { sessionId: this.sessionId, modeId })
      this.notices.delete('mode')
      this.setModeId(modeId)
      this.log(`[server] acp: session mode set to ${modeId} for "${mode}" from the pane`)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message: `The agent would not switch to the ${mode} posture (${detail}).` })
    }
  }

  /** Set the `model` config option (see `AcpAdapterProfile.modelVia`). The
   *  reply holds the resolved model; no update follows. */
  private async requestModel(model: string): Promise<void> {
    if (this.sessionId === undefined) throw new Error('no ACP session')
    const reply = await this.peer.request(ACP.sessionSetConfigOption,
      { sessionId: this.sessionId, configId: 'model', value: model })
    this.setModel(sessionModel(reply) ?? { id: model })
    this.log(`[server] acp: session model set to ${model}`)
  }

  /**
   * Work out whether a reattached agent is mid-turn and classify it. Any
   * status set during the read (a new prompt, an orphan reply) is newer than
   * the record, so a late scan result is discarded.
   */
  private async recover(): Promise<void> {
    let inFlight: AcpInFlight = { prompt: false }
    if (this.deps.recoverInFlight !== undefined) {
      try {
        inFlight = await this.deps.recoverInFlight()
      } catch (err) {
        // Erring toward idle only mislabels; erring toward busy pins the
        // conversation with nothing to release it.
        this.log(`[server] acp: could not recover turn state: ${
          err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Asks can only be outstanding inside a running turn.
    let awaiting: Array<string | number> = []
    const running = inFlight.prompt || inFlight.agentRunning === true
    if (running && this.deps.recoverPendingPermissions !== undefined) {
      try {
        awaiting = await this.deps.recoverPendingPermissions()
      } catch (err) {
        this.log(`[server] acp: could not recover permission state: ${
          err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (this.closed) return
    // A report received live during the read is newer.
    if (this.agentRunning === undefined) this.setAgentRunning(inFlight.agentRunning)
    if (this.backgroundWork === undefined && this.backgroundSettle === undefined) {
      this.setBackgroundWork(inFlight.backgroundWork, { settle: false })
    }
    if (this.statusKnown) return
    // Record asks before publishing status, so the first classification
    // already includes them.
    for (const id of awaiting) {
      const requestId = String(id)
      if (this.pendingPermissions.has(requestId) || this.answeredPermissions.has(requestId)) continue
      this.recoveredPermissions.set(requestId, id)
    }
    if (this.recoveredPermissions.size > 0) {
      this.log('[server] acp: reattached to a conversation blocked on a permission decision')
    }
    this.setBusy(inFlight.prompt)
    if (this.recoveredPermissions.size > 0) this.publishPermissionPending()
    // Last, so an early click settles the ask it was for.
    this.applyDeferredAnswers()
  }

  private markReady(): void {
    this.ready = true
    for (const w of this.readyWaiters) w()
    this.readyWaiters = []
    // The handshake has settled the mode and what the session offers.
    this.publishPermissionModes()
  }

  /** Fail everything waiting for readiness, so callers can fail over to the
   *  replacement connection instead of timing out. */
  private failWaiters(err: Error): void {
    for (const w of this.readyWaiters) w(err)
    this.readyWaiters = []
  }

  /** Resolve once the handshake has finished (session, launch model and
   *  mode all applied), so a prompt sent while the agent starts waits
   *  rather than fails. */
  whenReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.closed) return Promise.reject(new Error('conversation is closed'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the ACP session')), timeoutMs)
      this.readyWaiters.push((err) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * Send a user message; resolves when its turn ends, or once the agent
   * takes it as a steer. Callers do not await it (panes are fed by events).
   * `images` follow the text as image blocks; every adapter yaac runs
   * supports them.
   *
   * Mid-turn, an adapter that steers gets the message added to the running
   * turn, as its TUI would. Otherwise, or if the agent does not take the
   * steer, it queues behind the turn. Messages are routed one at a time, so
   * one sent while an earlier steer is unanswered cannot overtake it.
   */
  async prompt(text: string, images: readonly AcpImage[] = [], timeoutMs = 120_000): Promise<void> {
    try {
      await this.whenReady(timeoutMs)
    } catch (err) {
      // Both callers are fire-and-forget, so tell the pane or the message
      // would vanish with only a log line.
      this.emit({
        type: 'error',
        message: `could not deliver the message: ${err instanceof Error ? err.message : String(err)}`,
      })
      throw err
    }
    if (this.sessionId === undefined) throw new Error('no ACP session')
    const blocks = [
      ...(text === '' ? [] : [{ type: 'text', text }]),
      ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data })),
    ]
    // `done` is wrapped so routing settles without waiting for the turn.
    const routed = this.intake.then(async () => {
      // On a reattach, steering depends on whether the recovered turn runs.
      await this.whenStatus(() => this.statusKnown)
      if (this.isBusy && this.queue.length === 0 && this.deps.profile?.steers === true && await this.steer(blocks)) {
        return { done: Promise.resolve() }
      }
      return { done: this.enqueue({ id: randomUUID(), text, images: images.length, blocks }) }
    })
    this.intake = routed
    return (await routed).done
  }

  /**
   * Add a message to the running turn. Returns whether the agent took it;
   * anything else (the turn already over, an adapter without steering, a
   * failure) leaves the message for the queue rather than losing it.
   *
   * codex-acp ignores `promptRequired`: a steer arriving as its turn ends
   * starts a new turn itself (`startedNewTurn`), which answers no
   * `session/prompt` of ours. Like any turn the agent starts, it runs until
   * codex reports its thread idle (`agentRunningReport`).
   */
  private async steer(prompt: Array<Record<string, string>>): Promise<boolean> {
    try {
      const result = await this.peer.request<{ outcome?: string }>(ACP.sessionSteer, {
        sessionId: this.sessionId,
        prompt,
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      })
      if (result.outcome === 'startedNewTurn') this.setAgentRunning(true)
      if (result.outcome === 'injected' || result.outcome === 'startedNewTurn') return true
      if (result.outcome !== 'promptRequired') this.log(`[server] acp: steer not taken (${String(result.outcome)}); queueing`)
      return false
    } catch (err) {
      this.log(`[server] acp: steer failed, queueing instead: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** Queue a message behind the running turn; resolves when its turn ends. */
  private enqueue(entry: AcpQueuedPrompt & { blocks: Array<Record<string, string>> }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...entry, resolve, reject })
      // A message that starts at once was never waiting, so panes are not
      // shown it as queued.
      if (this.holdsPrompts || this.draining) this.publishQueue()
      void this.drain()
    })
  }

  /**
   * Hand the queue to the conversation that replaces this one after a
   * dropped connection (`AcpConversationDeps.queue`), so it survives the
   * reconnect. Leaves this conversation's queue empty.
   */
  takeQueue(): QueuedTurn[] {
    return this.queue.splice(0)
  }

  /** Drop a queued message before it is sent. A message already sent is
   *  past recall, so an unknown id is ignored. */
  unqueue(id: string): void {
    const i = this.queue.findIndex((q) => q.id === id)
    if (i === -1) return
    const [dropped] = this.queue.splice(i, 1)
    dropped.resolve()
    this.publishQueue()
  }

  /** Run queued turns one at a time until the queue is empty. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        // Wait out a turn this connection did not start (`holdsPrompts`),
        // and on a reattach the read that says whether one is running.
        await this.whenIdle()
        await this.delivered
        const next = this.queue.shift()
        if (next === undefined) return
        this.publishQueue()
        await this.runTurn(next.blocks).then(next.resolve, next.reject)
      }
    } finally {
      this.draining = false
    }
  }

  /** One prompt turn. */
  private async runTurn(prompt: Array<Record<string, string>>): Promise<void> {
    if (this.closed) throw new Error('conversation is closed')
    if (this.sessionId === undefined) throw new Error('no ACP session')
    this.setBusy(true)
    try {
      const result = await this.peer.request<AcpPromptResult>(ACP.sessionPrompt, {
        sessionId: this.sessionId,
        prompt,
      })
      this.endTurn(result.stopReason)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A refused prompt can mean the adapter lost its agent (claude's CLI
      // exiting closes its query stream without an idle report), so its last
      // report is no longer believed either.
      this.setAgentRunning(undefined)
      this.setBusy(false)
      this.emit({ type: 'error', message })
      throw err
    }
  }

  /** Stop one background task (claude's and codex's adapters announce
   *  them). The adapter reports the stop as the task's state, through the
   *  record. */
  async stopTask(taskId: string): Promise<void> {
    if (this.sessionId === undefined) throw new Error('no ACP session')
    await this.peer.request(ACP.asyncTaskStop, { sessionId: this.sessionId, asyncTaskId: taskId })
  }

  /** The end of a background task's output file; `path` is the one the
   *  adapter announced (see `attachAcp`). */
  async readTaskOutput(path: string): Promise<string> {
    if (this.deps.tailFile === undefined) throw new Error('task output is not readable here')
    return this.deps.tailFile(path, TASK_OUTPUT_BYTES)
  }

  /**
   * Interrupt the running turn. ACP's cancel is a notification; the agent
   * ends the turn with `cancelled` as the `session/prompt` reply, or (for a
   * turn it started itself) by reporting itself idle.
   *
   * With no prompt of ours running, the adapter's report is dropped at once
   * rather than waiting for that idle report, which may never come: claude's
   * adapter sends none once its CLI is gone, and a start pi-acp never
   * reported has no end report either. A run that goes on reports again.
   */
  cancel(): void {
    if (this.sessionId === undefined || !this.isBusy) return
    // ACP makes the cancelling client resolve outstanding permission
    // requests (see cancelPendingPermissions).
    this.cancelPendingPermissions()
    this.peer.notify(ACP.sessionCancel, { sessionId: this.sessionId })
    if (!this.busy) this.setAgentRunning(undefined)
  }

  private onClose(reason: string): void {
    if (this.closed) return
    // Not an error or a turn end: acpd still holds the agent, and the turn
    // may still be running. The pane greys out and resumes on reconnect.
    this.deps.onDown(reason)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.backgroundSettle)
    // Settle parked asks so their requests are not left pending. The
    // replies are microtasks that run after `peer.close()` below, so none
    // reaches the agent: a detach is not the user declining, and the next
    // connection recovers the asks from the record.
    this.cancelPendingPermissions()
    this.failWaiters(new Error('conversation is closed'))
    // Release the queue; its turns then fail as closed.
    this.wakeStatusWaiters()
    this.peer.close()
    for (const fn of this.closeSubscribers) fn()
    this.closeSubscribers.clear()
    this.subscribers.clear()
    this.queueSubscribers.clear()
  }
}
