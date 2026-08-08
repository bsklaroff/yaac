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
 *  2. The reply to the `session/prompt` that was in flight belongs to a
 *     request id the previous connection allocated. It arrives as an orphan
 *     response, which is read here as "that turn ended" — the conservative
 *     direction, since the alternative leaves a conversation permanently
 *     showing as busy.
 */

import { JsonRpcCallError, JsonRpcPeer, type JsonRpcTransport } from './acp-jsonrpc'
import {
  ACP,
  ACPD,
  ACP_PROTOCOL_VERSION,
  chooseAllowOption,
  clientCapabilities,
  toStopReason,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
} from './acp-protocol'
import { serverLog } from '#log'
import type { AcpEventInit } from '@yaac/shared/acp'

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
  /** Turn started / turn ended — this conversation's running/waiting. */
  onBusy: (busy: boolean) => void
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
   * Tail of the prompt-turn chain. ACP adapters assume one turn at a time, and
   * nothing upstream enforces it — a second Enter mid-turn reaches here — so
   * turns queue rather than overlap. Without this the FIRST reply ends the
   * turn while the second is still streaming, and the conversation reports
   * `waiting` while its agent is plainly working.
   */
  private turn: Promise<void> = Promise.resolve()
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

  constructor(private readonly deps: AcpConversationDeps) {
    this.log = deps.log ?? serverLog
    this.sessionId = deps.resumeSessionId
    this.peer = new JsonRpcPeer(deps.transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
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

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.deps.onBusy(busy)
  }

  private endTurn(stopReason: Parameters<typeof toStopReason>[0]): void {
    if (!this.busy) return
    this.setBusy(false)
    this.emit({ type: 'turn-end', stopReason: toStopReason(stopReason) })
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
   * Serve a request the agent makes of us. Returns a promise because the peer
   * contract is async — a client that served `fs/*` would do real I/O here —
   * but every answer yaac gives is a decision it can make on the spot.
   */
  private onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === ACP.requestPermission) {
      // Always allow — see chooseAllowOption for why a yaac session grants
      // rather than prompts. `selected` with no option id would be malformed,
      // so an agent that offered none is refused instead.
      const optionId = chooseAllowOption(params)
      return Promise.resolve(optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } })
    }
    // fs/* and terminal/* are declined in `clientCapabilities`, so an agent
    // asking anyway is out of contract; JsonRpcPeer answers method-not-found
    // by throwing here.
    throw new JsonRpcCallError({ code: -32601, message: `yaac does not serve ${method}` })
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
        this.markReady()
        return
      }

      const init = await this.peer.request<AcpInitializeResult>(ACP.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities(),
      })

      const canLoad = init.agentCapabilities?.loadSession === true
      if (this.sessionId !== undefined && canLoad) {
        // Replays the whole conversation as `session/update` notifications,
        // which is exactly the pane's history — so a restarted worktree comes
        // back with its transcript already on screen.
        await this.peer.request(ACP.sessionLoad, {
          sessionId: this.sessionId,
          cwd: this.deps.cwd,
          mcpServers: [],
        })
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
        this.deps.onSessionId(created.sessionId)
      }
      this.markReady()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[server] acp: handshake failed: ${message}`)
      this.emit({ type: 'error', message: `ACP handshake failed: ${message}` })
      this.deps.onDown(`handshake failed: ${message}`)
    }
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
    this.failWaiters(new Error('conversation is closed'))
    this.peer.close()
    for (const fn of this.closeSubscribers) fn()
    this.closeSubscribers.clear()
    this.subscribers.clear()
  }
}
