/**
 * One live ACP conversation: the server's half of the JSON-RPC dialogue with
 * an agent running under acpd in a session pod.
 *
 * An `AcpConversation` owns everything that has to survive a browser tab
 * closing and everything that has to survive the *connection* dropping:
 *
 *  - the ACP session id (`session/new` mints it; a reconnect reuses it),
 *  - whether a prompt turn is in flight, which is this conversation's
 *    running/waiting status.
 *
 * It does not own the conversation's content. That is in acpd's record, which
 * a pane tails; this class never sees a rendered message go past.
 *
 * It does NOT own the connection's retry policy. Like the tmux status
 * watcher, reconnect-with-backoff belongs to the caller (`acp-driver.ts`), so
 * both modes get one respawn strategy instead of two.
 *
 * ## Reconnect
 *
 * acpd keeps the agent alive across detaches, so a reconnect lands on a
 * process mid-conversation — possibly mid-turn. Two things follow, and both
 * are why acpd's `_acpd/hello` carries `firstAttach`:
 *
 *  1. The ACP handshake (`initialize`, then `session/new`) runs once per agent
 *     *process*, not once per connection. Re-running it against a live agent
 *     is undefined; on a reattach this class skips straight to consuming
 *     notifications for the session id it already holds.
 *  2. Whether a turn is running is not something the new connection can be
 *     told. ACP scopes turn state to the request — a turn is in flight iff
 *     *your* `session/prompt` is unanswered — and offers no status query, no
 *     busy notification, and no `session/load` semantics for a turn already in
 *     progress. So a reattach reconstructs it from the record instead
 *     (`recoverInFlight`), which has both directions and can therefore say
 *     whether the last prompt was ever answered.
 *
 * Recovery is a file read, so two faster answers can beat it, and both are
 * newer than the record: a prompt sent since the reattach, and the recovered
 * turn's own reply arriving as an orphan response (its request id belongs to
 * the previous connection, so it can only be read as "that turn ended"). The
 * first classification wins and the scan's verdict is dropped — which is what
 * keeps a stale `true` from pinning a finished conversation busy.
 */

import { JsonRpcCallError, JsonRpcPeer, type JsonRpcTransport } from './acp-jsonrpc'
import {
  ACP,
  ACPD,
  ACP_PROTOCOL_VERSION,
  acpModeOffered,
  chooseAllowOption,
  clientCapabilities,
  permissionReply,
  toStopReason,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpLoadSessionResult,
  type AcpSessionModes,
} from './acp-protocol'
import type { AcpAdapterProfile } from './acp-adapters'
import { serverLog } from '#log'
import type { AcpEventInit } from '@yaac/shared/acp'
import type { PermissionMode } from '@yaac/shared/types'

export interface AcpConversationDeps {
  /** The pod-side transport, already dialed. */
  transport: JsonRpcTransport
  /** The agent's working directory — always /workspace in a session pod. */
  cwd: string
  /**
   * The ACP session id to resume, when yaac already recorded one for this
   * conversation (a restart, or a reconnect after the server itself
   * restarted). Absent on a genuinely new conversation.
   */
  resumeSessionId?: string
  /** Optional tap on the event stream for the connection that owns this
   *  conversation. Panes use `subscribe` instead — they come and go, and the
   *  owner must not have to multiplex them. */
  onEvent?: (event: AcpEventInit) => void
  /** Fired when the ACP session id is first known, so the caller can record
   *  it. Not fired on a resume, where the caller supplied it. */
  onSessionId: (agentSessionId: string) => void
  /**
   * Turn started, turn ended, or the status was resolved for the first time —
   * this conversation's running/waiting. The first call is what promotes it
   * from unclassified (`status === undefined`) to something a caller can
   * publish, so it fires even when the answer is the unremarkable `false`.
   */
  onBusy: (busy: boolean) => void
  /**
   * Whether a prompt turn was still in flight when the record was last
   * written — `readAcpInFlight` over this conversation's record. Consulted
   * once, on a reattach, because that is the only case where a turn this
   * connection did not start can be running. Absent (or throwing) means the
   * conversation resolves to idle, which is what it did before recovery
   * existed.
   */
  recoverInFlight?: () => Promise<boolean>
  /**
   * The permission asks the agent was still blocked on when the record was
   * last written — `readAcpPendingPermissions` over this conversation's
   * record. Consulted on a reattach for the same reason `recoverInFlight` is:
   * the ask was delivered to a connection that is gone, and nothing replays
   * it, so the record is the only evidence that a human is being waited on.
   */
  recoverPendingPermissions?: () => Promise<Array<string | number>>
  /**
   * This conversation's permission posture. An accessor rather than a value
   * because a conversation outlives the connection that built it, and the row
   * it comes from can be rewritten by a restart in between.
   *
   * It may answer `undefined`, meaning the posture is not known *yet* — the
   * row could not be read, or is not there. That is distinct from the accessor
   * being absent altogether; see `permissionMode()` for why the two get
   * opposite answers.
   */
  permissionMode?: () => PermissionMode | undefined
  /**
   * What this conversation's adapter can be told, and how. Absent for a
   * caller that has no adapter in hand — a test driving the protocol directly
   * — which reads as "tell it nothing": no mode is set and no model is sent,
   * leaving the adapter in its own default, which is the strict one.
   */
  profile?: Pick<AcpAdapterProfile, 'modeIds' | 'modelVia' | 'forwardAsksUnderBypass'>
  /**
   * The model this conversation was launched to run, for an adapter that can
   * only be told one over the protocol. Sent once, after `session/new` —
   * never after a `session/load`, which lands on an adapter that already holds
   * a model the user may since have changed.
   */
  launchModel?: string
  /**
   * An ask started or stopped blocking the agent. Separate from `onBusy`
   * because it is a different question about the same turn: `busy` says a turn
   * is running, this says the turn is not going anywhere until a human answers.
   */
  onPermissionPending?: (pending: boolean) => void
  onDown: (reason: string) => void
  log?: (msg: string) => void
}

export class AcpConversation {
  private readonly peer: JsonRpcPeer
  private readonly log: (msg: string) => void
  private readonly subscribers = new Set<(event: AcpEventInit) => void>()
  private readonly closeSubscribers = new Set<() => void>()
  private sessionId: string | undefined
  private busy = false
  /**
   * Whether `busy` is an answer yet. A conversation that has only just
   * attached knows nothing: it may have landed on an agent that is working,
   * and saying "idle" in the meantime would stamp a waiting spell on it. So
   * `status` stays undefined until the handshake — or recovery — settles it.
   */
  private statusKnown = false
  /**
   * Tail of the prompt-turn chain. ACP adapters assume one turn at a time, and
   * nothing upstream enforces it — a second Enter mid-turn reaches here — so
   * turns queue rather than overlap. Without this the FIRST reply ends the
   * turn while the second is still streaming, and the conversation reports
   * `waiting` while its agent is plainly working.
   */
  private turn: Promise<void> = Promise.resolve()
  /**
   * Woken when a turn ends. A *recovered* turn is running at the adapter but
   * is not in `turn` — nothing here chained it, since nothing here started it —
   * so this is the slot it occupies in the queue. Only ever waited on for that
   * turn: this connection's own are already serialized.
   */
  private idleWaiters: Array<() => void> = []
  private ready = false
  /**
   * acpd's greeting is the first line of a connection, always. Accepting a
   * later one would let the AGENT forge it — acpd is a dumb pipe, so anything
   * the adapter prints reaches us verbatim — and a forged `firstAttach:true`
   * would start a second handshake against a live process.
   */
  private helloSeen = false
  private readyWaiters: Array<(err?: Error) => void> = []
  private closed = false
  /**
   * Permission asks this connection is holding open, by the agent's own
   * request id. The value settles the served request, which is what unblocks
   * the agent — so an entry here is a turn parked on a human.
   */
  private readonly pendingPermissions = new Map<string, (result: unknown) => void>()
  /**
   * Asks already settled, so a second answer for one is dropped rather than
   * sent. Two panes can hold the same card, and the loser's click arrives
   * after the winner's — and across a reconnect an answer takes the
   * `respondTo` path, which has no pending entry to consume and would
   * otherwise let every late click write another reply to the agent.
   */
  private readonly answeredPermissions = new Set<string>()
  /**
   * Asks recovered from the record on a reattach — outstanding at the agent,
   * but received by a connection that is gone, so there is no served promise
   * here to resolve. Valued by the id as the agent wrote it, because that is
   * what the reply has to carry to be paired with the request.
   */
  private readonly recoveredPermissions = new Map<string, string | number>()
  /**
   * Answers for asks this connection did not know about when they arrived —
   * a pane clicking a recovered card while `recover()` is still reading the
   * record. Applied the moment recovery names the ask, so the user's decision
   * lands instead of vanishing into a window they cannot see.
   */
  private readonly deferredAnswers = new Map<string, unknown>()
  /** What `session/new` (or `session/load`) said this session's modes are. */
  private sessionModes: AcpSessionModes | undefined

  constructor(private readonly deps: AcpConversationDeps) {
    this.log = deps.log ?? serverLog
    this.sessionId = deps.resumeSessionId
    this.peer = new JsonRpcPeer(deps.transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onOrphanResponse: () => this.endTurn('end_turn'),
      onClose: (reason) => this.onClose(reason),
    })
  }

  /** The ACP session id, once the handshake has produced one. */
  get agentSessionId(): string | undefined {
    return this.sessionId
  }

  get isBusy(): boolean {
    return this.busy
  }

  /**
   * This conversation's classification, or undefined while it has none —
   * mid-handshake, or reading the record to find out whether the agent it just
   * reattached to is mid-turn. A caller that publishes status must skip an
   * undefined rather than defaulting it: `waiting` for a working agent is the
   * exact bug recovery exists to fix.
   */
  get status(): 'running' | 'waiting' | undefined {
    if (!this.statusKnown) return undefined
    // A turn blocked on a permission ask is `busy` — its `session/prompt` is
    // unanswered — but it is not working, it is waiting for the user. Reporting
    // `running` would be the exact inverse of what the sidebar dot, the chime
    // and the tray badge are for: the one moment the conversation genuinely
    // wants attention is the one it would look busiest.
    if (this.isAwaitingPermission) return 'waiting'
    return this.busy ? 'running' : 'waiting'
  }

  /** Whether the agent is parked on an ask nobody has answered. */
  get isAwaitingPermission(): boolean {
    return this.pendingPermissions.size > 0 || this.recoveredPermissions.size > 0
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Watch the live stream. Returns the unsubscribe.
   *
   * Events arrive unsequenced: history comes from the record acpd writes, and
   * each attach numbers that record from zero, so only the subscriber knows
   * where its own numbering has reached. Several panes can watch one
   * conversation at once (two browser tabs), which is why this is a set rather
   * than the single-owner callback `onEvent` is.
   */
  subscribe(fn: (event: AcpEventInit) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /** Watch for the conversation being torn down, so an attached pane can grey
   *  out instead of silently going quiet. Returns the unsubscribe. */
  onClosed(fn: () => void): () => void {
    if (this.closed) {
      fn()
      return () => { /* already fired */ }
    }
    this.closeSubscribers.add(fn)
    return () => this.closeSubscribers.delete(fn)
  }

  /**
   * Publish one of the few events the record cannot carry: a turn boundary and
   * an error, both of which are statements about what is happening *now*
   * rather than what was said. Content never comes through here — see
   * `onNotification` — so these can never duplicate what a tail delivers.
   */
  private emit(event: AcpEventInit): void {
    this.deps.onEvent?.(event)
    for (const fn of this.subscribers) fn(event)
  }

  /**
   * Settle the conversation's status. The first call always publishes, even
   * when it resolves to the same `false` the field started at: "idle" and "not
   * classified yet" are different states to a caller, and the first is only
   * reached by saying so.
   */
  private setBusy(busy: boolean): void {
    if (this.statusKnown && this.busy === busy) return
    // A turn *beginning* — as opposed to a status merely being resolved as
    // running. Only that is worth an event.
    const started = busy && !this.busy
    this.statusKnown = true
    this.busy = busy
    // A pane's ONLY start signal, so every start is announced — the recovered
    // turn nobody typed into this connection included. A pane deliberately
    // infers nothing from content: a replay is made of `user` messages and the
    // record carries no boundary to close them with, so reading one as a turn
    // beginning latches it on history (docs/agent-modes.md).
    if (started) this.emit({ type: 'turn-start' })
    if (!busy) this.wakeIdleWaiters()
    this.deps.onBusy(busy)
  }

  /** Release whatever is queued behind a turn this connection did not start. */
  private wakeIdleWaiters(): void {
    for (const fn of this.idleWaiters) fn()
    this.idleWaiters = []
  }

  /**
   * Resolve once no turn is running. This connection's own turns are already
   * serialized by `turn`, so the only thing this ever waits out is a recovered
   * one — which ends by the same routes that classify it: the orphan reply, the
   * agent exiting, or the conversation closing.
   *
   * A turn recovered from a *torn* record has none of those routes, since the
   * reply it is waiting for was already produced and lost. That conversation
   * holds its queue until the worktree restarts (docs/agent-modes.md, "Where
   * status can mislead"). Deliberate: the alternative is releasing the queue on
   * a timer, which cannot tell a phantom from an agent that is simply taking a
   * long time, and would dispatch over a turn that really is running.
   */
  private whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private endTurn(stopReason: Parameters<typeof toStopReason>[0]): void {
    const wasBusy = this.busy
    // Unconditional, so an orphan reply (or the agent exiting) settles a
    // conversation whose recovery has not answered yet — and, being first,
    // beats it. There is nothing to end, but there is something to classify.
    this.setBusy(false)
    if (wasBusy) this.emit({ type: 'turn-end', stopReason: toStopReason(stopReason) })
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
        // Nothing is left to answer: the process that asked is gone, and a
        // parked promise would keep the conversation reading as `waiting` on a
        // decision that can no longer reach anyone.
        this.cancelPendingPermissions()
        this.endTurn('cancelled')
        this.emit({ type: 'error', message: `the agent process exited (code ${code ?? '?'})` })
        return
      }
      case ACP.sessionUpdate:
        // Deliberately ignored. Conversation content reaches a pane by one
        // path only — acpd's record — because the record and this socket carry
        // the same notifications and ACP gives notifications no identity, so
        // joining the two at an unknown point would either duplicate the
        // overlap or drop it. What is left here is the RPC half: our requests
        // and their replies, and the agent's own questions.
        return
      default:
        return
    }
  }

  /**
   * Serve a request the agent makes of us.
   *
   * Under `bypass` every answer is one this can make on the spot. Under any
   * other posture a permission ask is the user's to answer, so the promise is
   * parked — deliberately without a timeout. The agent is blocked until it
   * settles, and there is no deadline that is right: a person may be at lunch,
   * and answering *for* them after five minutes is the auto-approval the
   * posture exists to refuse. What releases it instead is a decision, a cancel,
   * the agent exiting, or the conversation closing — all of which settle the
   * map explicitly.
   */
  private onRequest(method: string, params: unknown, id: string | number): Promise<unknown> {
    if (method === ACP.requestPermission) {
      // `bypass` waives permission prompts, and for most adapters that is all
      // an ask can be. pi is the exception: it has no permission system, so
      // what arrives on this method are its extensions' own questions — a
      // choice a person is being asked to make, which auto-answering would
      // make for them.
      if (this.permissionMode() === 'bypass' && !this.forwardsAsksUnderBypass()) {
        // See chooseAllowOption: a bypassed session grants rather than prompts.
        // `selected` with no option id would be malformed, so an agent that
        // offered none is refused instead.
        return Promise.resolve(permissionReply(chooseAllowOption(params)))
      }
      const requestId = String(id)
      this.log(`[server] acp: awaiting a permission decision on ${requestId}`)
      return new Promise<unknown>((resolve) => {
        this.pendingPermissions.set(requestId, resolve)
        // The same ask cannot be both recovered and served — but if the record
        // scan and the live delivery raced over one, the served promise is the
        // better handle on it.
        this.recoveredPermissions.delete(requestId)
        this.publishPermissionPending()
      })
    }
    // fs/* and terminal/* are declined in `clientCapabilities`, so an agent
    // asking anyway is out of contract; JsonRpcPeer answers method-not-found
    // by throwing here.
    throw new JsonRpcCallError({ code: -32601, message: `yaac does not serve ${method}` })
  }

  /**
   * The posture to answer by, or undefined when it is not known yet — a row
   * that could not be read, or one that is not there.
   *
   * Unknown is deliberately NOT `bypass`. The two answers are not symmetric:
   * parking an ask that could have been auto-granted costs the user a click,
   * while auto-granting one that should have been asked about is irreversible
   * and silent. So the only thing that reaches the auto-answer is a posture
   * positively read as `bypass`.
   *
   * A caller supplying no accessor at all is a different case — it predates
   * postures entirely, and gets the answer every ACP conversation used to.
   */
  private permissionMode(): PermissionMode | undefined {
    if (this.deps.permissionMode === undefined) return 'bypass'
    return this.deps.permissionMode()
  }

  /** Whether this adapter's asks reach the user even under `bypass`. */
  private forwardsAsksUnderBypass(): boolean {
    return this.deps.profile?.forwardAsksUnderBypass === true
  }

  /** Say what this conversation's status is now, since a pending ask changes
   *  it without any turn boundary having happened. */
  private publishPermissionPending(): void {
    this.deps.onPermissionPending?.(this.isAwaitingPermission)
  }

  /**
   * Settle a permission ask with the user's decision. `optionId` absent means
   * they dismissed it, which the agent is told as `cancelled`.
   *
   * Two paths, because an ask outlives the connection that received it. The
   * ordinary one resolves the served request. The other answers an ask this
   * connection never saw — the relay dropped, or the server restarted, while
   * the agent sat blocked — by writing the reply against the agent's own id,
   * which is not namespaced to any connection of ours. Without it a pane could
   * show a live question that nothing could answer, and the only cure would be
   * restarting the worktree mid-turn.
   */
  answerPermission(requestId: string, optionId?: string): void {
    if (this.answeredPermissions.has(requestId)) {
      this.log(`[server] acp: permission ${requestId} already answered — ignoring`)
      return
    }
    this.settlePermission(requestId, permissionReply(optionId))
  }

  /**
   * Send one answer by whichever route this connection has to the agent, and
   * republish the status the ask was holding down.
   *
   * An answer matching neither map is *held* rather than dropped, and
   * deliberately not recorded as answered. A pane can legitimately answer an
   * ask this connection does not know about yet: the registry publishes a
   * conversation the moment it is constructed, and a reattaching pane replays
   * the pending card straight from the record — but `recover()` only learns
   * which asks are outstanding after acpd's greeting and two file reads. A
   * click in that window has a real ask behind it; recording it as answered
   * would make `recover()` skip the very id it belongs to, leaving the agent
   * blocked with a dead card until the worktree restarts.
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
        // Addressed as the AGENT wrote it: JSON-RPC pairs an id by value and
        // type, so a numeric `42` answered as `"42"` is a reply it never
        // matches and a turn that stays blocked.
        this.peer.respondTo(recovered, result)
      }
      this.publishPermissionPending()
      return
    }
    // Unknown to this connection. Held for a recovery that may still name it;
    // if none ever does, it costs one map entry for the life of a conversation
    // that is by then answering nothing.
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
   * Give up on every open ask. Used where the answer can no longer matter: the
   * turn is being cancelled, the agent is gone, or this connection is going
   * away. ACP asks a client to resolve outstanding permission requests when it
   * cancels, and leaving one unresolved strands the served promise — which is
   * a request `JsonRpcPeer` is still awaiting and would never reply to.
   */
  private cancelPendingPermissions(): void {
    // Held answers go too: the turn they were meant for is over, and applying
    // one to a later ask that happened to reuse the id would answer a question
    // the user never read.
    this.deferredAnswers.clear()
    if (!this.isAwaitingPermission) return
    for (const [requestId, resolve] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId)
      this.answeredPermissions.add(requestId)
      resolve(permissionReply(undefined))
    }
    // A recovered ask has no promise to settle here, and answering it over the
    // wire would be answering for the user; the turn it belonged to is being
    // abandoned either way, so it is simply dropped.
    this.recoveredPermissions.clear()
    this.publishPermissionPending()
  }

  /**
   * Bring the conversation to the point where `prompt()` can run: on a first
   * attach that means the full ACP handshake, and on a reattach it means
   * nothing at all (the agent is already initialized — re-running `initialize`
   * against a live process is undefined).
   */
  private async handshake(firstAttach: boolean): Promise<void> {
    try {
      if (!firstAttach) {
        if (this.sessionId === undefined) {
          throw new Error('reattached to a live agent with no recorded session id')
        }
        this.log(`[server] acp: reattached to session ${this.sessionId}`)
        // Ready before recovery: a prompt typed into the pane must not wait on
        // a file read to find out what the *previous* connection was doing.
        this.markReady()
        await this.recover()
        return
      }

      const init = await this.peer.request<AcpInitializeResult>(ACP.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities(),
      })

      const canLoad = init.agentCapabilities?.loadSession === true
      if (this.sessionId !== undefined && canLoad) {
        // For most adapters this replays the whole conversation as
        // `session/update` notifications, which is exactly the pane's history
        // — so a restarted worktree comes back with its transcript already on
        // screen. For one that replays nothing (opencode) the history is in
        // the record instead, which is why acpd was told to keep it
        // (`--append`); either way the pane reads the record, so the two look
        // the same from here.
        const loaded = await this.peer.request<AcpLoadSessionResult>(ACP.sessionLoad, {
          sessionId: this.sessionId,
          cwd: this.deps.cwd,
          mcpServers: [],
        })
        this.sessionModes = loaded.modes
      } else {
        if (this.sessionId !== undefined) {
          this.log('[server] acp: adapter cannot load sessions — starting a fresh conversation')
        }
        const created = await this.peer.request<AcpNewSessionResult>(ACP.sessionNew, {
          cwd: this.deps.cwd,
          mcpServers: [],
        })
        if (typeof created.sessionId !== 'string' || created.sessionId === '') {
          throw new Error('session/new returned no session id')
        }
        this.sessionId = created.sessionId
        this.sessionModes = created.modes
        this.deps.onSessionId(created.sessionId)
        await this.applyLaunchModel()
      }
      await this.applyPermissionMode()
      this.markReady()
      // A first attach is a fresh agent process, so nothing can be in flight —
      // said out loud, because a caller cannot publish an unclassified
      // conversation and this one is done being unclassified.
      this.setBusy(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[server] acp: handshake failed: ${message}`)
      this.emit({ type: 'error', message: `ACP handshake failed: ${message}` })
      this.deps.onDown(`handshake failed: ${message}`)
    }
  }

  /**
   * Put the session in the mode its posture names.
   *
   * This is what makes a posture mean anything: forwarding asks to the pane
   * only decides who answers the questions, and the mode decides which
   * questions get asked at all. Without it `accept-edits` would prompt for
   * every edit — the adapter's own default is "ask about everything" — and the
   * user would be answering the restraint they asked to be spared.
   *
   * Only on a first attach, and deliberately so. A reattach lands on a live
   * adapter that is already holding a mode, and that mode may no longer be the
   * row's: leaving plan mode is itself a permission ask whose options ARE mode
   * ids, so a user who accepted "yes, and auto-accept edits" moved the session
   * to `acceptEdits`. Re-asserting the row here would drag them back into plan
   * mode on the next relay hiccup. The row wins again at the next restart,
   * which is the point at which it is the durable answer.
   *
   * A mode the adapter did not advertise is logged and skipped rather than
   * thrown: create refuses a posture the tool cannot express, so reaching this
   * means the session clamped one (`auto` on a model with no classifier,
   * `bypassPermissions` for an adapter running as root outside a sandbox), and
   * losing the conversation over it would be worse than running in the
   * adapter's default and prompting.
   */
  private async applyPermissionMode(): Promise<void> {
    if (this.sessionId === undefined) return
    const mode = this.permissionMode()
    if (mode === undefined) {
      // Nothing to assert, and the adapter's own default is the strict one —
      // it asks about everything, and this conversation forwards all of it.
      this.log('[server] acp: no posture known for this worktree'
        + ' — leaving the session in the adapter default and forwarding its asks')
      return
    }
    const modeId = this.deps.profile?.modeIds[mode]
    if (modeId === undefined) {
      // Either this adapter has no mode for this posture and is not meant to —
      // the posture rides its launch environment instead (opencode), or the
      // tool has no permission system to put in a mode (pi) — or no adapter
      // was named at all, which is a caller driving the protocol directly.
      // Create refuses any posture a tool cannot express, so there is nothing
      // to report here.
      return
    }
    if (this.sessionModes?.currentModeId === modeId) return
    if (!acpModeOffered(this.sessionModes, modeId)) {
      this.reportModeNotSet(mode, modeId, 'offers no such mode')
      return
    }
    try {
      await this.peer.request(ACP.sessionSetMode, { sessionId: this.sessionId, modeId })
      this.sessionModes = { ...this.sessionModes, currentModeId: modeId }
      this.log(`[server] acp: session mode set to ${modeId} for "${mode}"`)
    } catch (err) {
      // The same news as an unadvertised mode, and it has to be said the same
      // way. An adapter's own default is not always at least as strict as what
      // was asked — codex-acp's is `agent`, where a reviewer model approves
      // most actions, so an `accept-edits` conversation that lands here is
      // running looser than the create asked for. Logging alone would leave
      // that visible only to whoever reads the server's log, which is not the
      // person who chose the posture.
      this.reportModeNotSet(mode, modeId, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Tell the pane, and the log, that this conversation is not in the posture
   * it was created with.
   *
   * Deliberately says only what is true in every case it covers: which mode
   * the session is actually in. What happens to the agent's asks from here
   * varies — under `bypass` this client still answers them itself, and codex's
   * fallback `agent` mode has a reviewer model answering most of them — so
   * promising they will all arrive in the pane would be wrong twice over.
   */
  private reportModeNotSet(mode: PermissionMode, modeId: string, why: string): void {
    const message = `The agent would not switch to "${modeId}" for the ${mode} posture`
      + ` (${why}) — running in ${this.sessionModes?.currentModeId ?? 'its own default'} instead.`
    this.log(`[server] acp: ${message}`)
    this.emit({ type: 'error', message })
  }

  /**
   * Name the model on a freshly created session, for an adapter that takes one
   * no other way.
   *
   * Only after `session/new`. A `session/load` lands on an adapter that is
   * already holding a model — the one this conversation set when it was
   * created, or one the user has changed since — and re-asserting the launch
   * value there would quietly undo their choice on the next relay hiccup, the
   * same reason the posture is not re-asserted on a reattach.
   *
   * A refusal is reported and survived. The model is a preference, and losing
   * the conversation over one the adapter will not take (a provider with no
   * credential, an id retired upstream) would be worse than running the
   * adapter's own default — which the pane says out loud, because a worktree
   * created with `--model` and silently running another is a bill nobody
   * expects.
   */
  private async applyLaunchModel(): Promise<void> {
    const model = this.deps.launchModel
    if (model === undefined || this.sessionId === undefined) return
    try {
      await this.peer.request(ACP.sessionSetModel, { sessionId: this.sessionId, modelId: model })
      this.log(`[server] acp: session model set to ${model}`)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const message = `The agent would not switch to the model "${model}"`
        + ` — running its own default instead (${detail}).`
      this.log(`[server] acp: ${message}`)
      this.emit({ type: 'error', message })
    }
  }

  /**
   * Work out whether the agent this connection just took over is mid-turn, and
   * classify accordingly.
   *
   * Deliberately last-writer-*loses*: anything that resolved the status while
   * the record was being read knows something newer than the record does — a
   * prompt sent since, or the in-flight turn's reply arriving as an orphan — so
   * a scan that comes back afterwards is stale and says nothing.
   */
  private async recover(): Promise<void> {
    let inFlight = false
    if (this.deps.recoverInFlight !== undefined) {
      try {
        inFlight = await this.deps.recoverInFlight()
      } catch (err) {
        // Understating costs a `working…` label; overstating pins a finished
        // conversation busy with no event left to release it.
        this.log(`[server] acp: could not recover turn state: ${
          err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Only worth asking about a turn that is actually running: an ask can only
    // be outstanding inside one, and a finished turn's asks were all settled to
    // get it finished.
    let awaiting: Array<string | number> = []
    if (inFlight && this.deps.recoverPendingPermissions !== undefined) {
      try {
        awaiting = await this.deps.recoverPendingPermissions()
      } catch (err) {
        this.log(`[server] acp: could not recover permission state: ${
          err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (this.closed || this.statusKnown) return
    // Recorded before the status is published, so the first classification a
    // caller sees already accounts for it rather than flipping a moment later.
    for (const id of awaiting) {
      const requestId = String(id)
      if (this.pendingPermissions.has(requestId) || this.answeredPermissions.has(requestId)) continue
      this.recoveredPermissions.set(requestId, id)
    }
    if (this.recoveredPermissions.size > 0) {
      this.log('[server] acp: reattached to a conversation blocked on a permission decision')
    }
    this.setBusy(inFlight)
    if (this.recoveredPermissions.size > 0) this.publishPermissionPending()
    // Last, so a click that beat this scan settles the ask it was always for.
    this.applyDeferredAnswers()
  }

  private markReady(): void {
    this.ready = true
    for (const w of this.readyWaiters) w()
    this.readyWaiters = []
  }

  /** Fail everything queued behind readiness. A conversation being torn down
   *  will never become ready, and a caller left waiting out its full timeout
   *  cannot fail over to the connection that replaces this one. */
  private failWaiters(err: Error): void {
    for (const w of this.readyWaiters) w(err)
    this.readyWaiters = []
  }

  /** Resolve once the session exists. A prompt typed into the pane while the
   *  agent is still starting waits here instead of failing. */
  private whenReady(timeoutMs: number): Promise<void> {
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
   * Send a user message and run the turn. Resolves when the agent stops; the
   * caller does not await it (the pane is fed by events, not by this return).
   */
  async prompt(text: string, timeoutMs = 120_000): Promise<void> {
    try {
      await this.whenReady(timeoutMs)
    } catch (err) {
      // The ask never reached the agent. Both callers are fire-and-forget (the
      // pane's socket, and session create's initial ask), so without this the
      // message would vanish leaving nothing but a server log line — the user
      // sees an idle agent that was never told anything.
      this.emit({
        type: 'error',
        message: `could not deliver the message: ${err instanceof Error ? err.message : String(err)}`,
      })
      throw err
    }
    if (this.sessionId === undefined) throw new Error('no ACP session')
    const run = this.turn.then(() => this.runTurn(text))
    // The chain must survive a failed turn, or one rejection would strand every
    // message queued behind it.
    this.turn = run.catch(() => { /* reported to its own caller */ })
    return run
  }

  /** One prompt turn, run only once its predecessor has finished. */
  private async runTurn(text: string): Promise<void> {
    if (this.closed) throw new Error('conversation is closed')
    // A turn recovered from the record is running at the adapter but was never
    // put in `turn` — nothing here started it. Waiting it out is the same rule
    // the queue enforces for this connection's own turns: sending now would
    // overlap them at an adapter that assumes one at a time, and the first
    // reply back would end the wrong turn. Nothing running is the ordinary
    // case, and it costs no tick — the chain has already serialized our own.
    if (this.busy) {
      await this.whenIdle()
      if (this.closed) throw new Error('conversation is closed')
    }
    if (this.sessionId === undefined) throw new Error('no ACP session')
    this.setBusy(true)
    try {
      const result = await this.peer.request<AcpPromptResult>(ACP.sessionPrompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      this.endTurn(result.stopReason)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setBusy(false)
      this.emit({ type: 'error', message })
      throw err
    }
  }

  /** Interrupt the running turn. ACP's cancel is a notification: the agent
   *  answers by ending the turn with `cancelled`, which arrives as the
   *  `session/prompt` reply. */
  cancel(): void {
    if (this.sessionId === undefined || !this.busy) return
    // ACP puts resolving outstanding permission requests on the client when it
    // cancels. Leaving one parked would strand two things at once: the agent,
    // still waiting to be told, and the served request the peer is awaiting a
    // handler for and would never reply to.
    this.cancelPendingPermissions()
    this.peer.notify(ACP.sessionCancel, { sessionId: this.sessionId })
  }

  private onClose(reason: string): void {
    if (this.closed) return
    // Deliberately NOT an `error` event and NOT a turn end: acpd is still
    // holding the agent, and the turn may well still be running. The pane
    // greys out via the health message and picks up where it left off.
    this.deps.onDown(reason)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // Settles the parked asks WITHOUT any of them reaching the agent, and both
    // halves of that are deliberate. A parked promise is a request the peer is
    // awaiting a handler for; left unresolved it is never replied to and never
    // collected, and this object is meant to be finished with. But the reply a
    // resolve produces is an `await` continuation — a microtask, which cannot
    // run before `peer.close()` below — so nothing is written to a live agent.
    // That is the behavior we want: a detach is not the user declining, and an
    // ask left unanswered here is one the NEXT connection recovers from the
    // record and can still put in front of them.
    this.cancelPendingPermissions()
    this.failWaiters(new Error('conversation is closed'))
    // A prompt held behind a recovered turn would otherwise wait for a boundary
    // that can no longer arrive; released, it fails on the closed check above it.
    this.wakeIdleWaiters()
    this.peer.close()
    for (const fn of this.closeSubscribers) fn()
    this.closeSubscribers.clear()
    this.subscribers.clear()
  }
}
