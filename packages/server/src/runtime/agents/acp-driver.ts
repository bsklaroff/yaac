/**
 * The `acp` driver: a coding agent speaking the Agent Client Protocol
 * (JSON-RPC over stdio) instead of rendering a TUI.
 *
 * The agent still runs in a tmux window — that is not incidental. tmux is what
 * makes an agent survive the thing watching it: a closed tab, a dropped relay,
 * a restarted server. A plain streamd `ctrl` stream owns its child (socket
 * close ⇒ SIGTERM), which would put a running turn's life back on the
 * connection, and a PTY would corrupt the protocol outright. So the window
 * runs `acpd`, which owns the agent's stdio and republishes it on a UNIX
 * socket that can be attached to and detached from freely:
 *
 *     tmux window                                   this driver
 *     ┌─────────────────────────────┐               ┌──────────────────┐
 *     │ acpd ── stdio ── ACP agent  │               │ AcpConversation  │
 *     │   └── /tmp/yaac-acp/<w>.sock│◄──ctrl+socat──┤ (JSON-RPC peer)  │
 *     └─────────────────────────────┘               └──────────────────┘
 *
 * Keeping the agent in a window also means everything downstream of "a
 * conversation is a tmux window" keeps working untouched: the launch exec, the
 * restart path that respawns what was live, window-close teardown, and session
 * GC. The window is simply not PTY-attachable in the webapp — its pane renders
 * chat instead.
 *
 * Status is exact here, unlike the TUI mode's title scraping: a conversation is
 * `running` for precisely as long as a `session/prompt` request is in flight,
 * and `waiting` the moment the agent answers with a stop reason. That holds
 * across reconnects, where the request in flight belongs to a connection that
 * is gone — acpd's record is what makes such a turn knowable, since ACP itself
 * lets only the sender of a prompt know it is running.
 */

import { StringDecoder } from 'node:string_decoder'
import { type StreamChild } from '#drivers/contract'
import { worktreeDriver } from '#drivers/driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CONTAINER_TMUX_SOCK, containerAcpLog, containerAcpSock } from '@yaac/shared/paths'
import { acpLogDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import { AcpConversation } from './acp-client'
import { readAcpInFlight } from './acp-log'
import { agentWindowTool } from './agent-tools'
import {
  acpConversationByHandle,
  registerAcpConversation,
  unregisterAcpConversation,
} from './acp-registry'
import type { JsonRpcTransport } from './acp-jsonrpc'
import type {
  AgentConnectDeps,
  AgentConnection,
  AgentDriver,
  AgentLaunchSpec,
  AgentObservation,
  DrivenWorktree,
  LiveAgent,
} from './drivers'
import type { AgentTool } from '@yaac/shared/types'

/** Where the ACP adapter for each tool lives on the session image's PATH. */
const ACP_ADAPTERS: Partial<Record<AgentTool, string>> = {
  claude: 'claude-agent-acp',
}

/** How often the connection re-enumerates the pod's ACP windows, picking up a
 *  conversation opened (or closed) since the last look. */
const DEFAULT_SWEEP_MS = 20_000

/**
 * Sweep cadence while some window this connection knows about is not attached.
 *
 * Two states need it, and they are the same state. A session's agent window is
 * created by the host *after* the pod is Ready, so a connection that opened
 * first would otherwise sit out a full sweep before noticing it — and session
 * create waits on that attach to deliver the initial prompt. And a window that
 * exists is not yet a socket to connect to: acpd binds a moment after tmux
 * spawns it, so the first dial into a brand-new window usually finds nothing
 * listening and drops straight back off. Both are "a conversation is coming
 * up", and both are resolved by looking again in a second.
 *
 * The cadence rises to `DEFAULT_SWEEP_MS` once every enumerated window is
 * attached — or has spent its `MAX_FAST_ATTACH_ATTEMPTS` — so an idle worktree
 * costs one cheap exec every 20s rather than one per second. The cost of
 * getting this wrong is not a slow log line: until the dial lands there is no
 * handshake, so no conversation id, no row, and no chat pane — a fresh ACP
 * worktree stares at acpd's own output for the length of one sweep.
 */
const EMPTY_SWEEP_MS = 1_000

/**
 * How many times a window may fail to hold an attach before it stops earning
 * the fast cadence and is only retried on the settled one.
 *
 * A window that has bounced this many times is not starting — acpd crashed or
 * wedged and tmux left the window behind, or its socket is gone — and retrying
 * it every second forever costs an exec and a dial per second, per broken
 * window, for as long as the pod lives. It still gets re-dialed every
 * `DEFAULT_SWEEP_MS`, so a window that heals is picked up; it just stops
 * holding its worktree's whole connection at the fast cadence while it does
 * not.
 *
 * Ten rather than a snug two or three, because the two sides of this budget
 * are not symmetric. Spending it costs ten dials, once — trivial. Running out
 * of it early costs a real conversation a full settled sweep, which is the
 * pane delay this whole path exists to remove. acpd binds before it spawns the
 * adapter, so a healthy window is attachable in milliseconds; ten seconds is
 * headroom for a gVisor pod on a loaded node, not the expected cost.
 */
export const MAX_FAST_ATTACH_ATTEMPTS = 10

/** How long `deliverPrompt` waits for a conversation to finish its handshake
 *  before giving up. Generous: it covers an adapter's cold start. */
const PROMPT_ATTACH_TIMEOUT_MS = 60_000

/** Deadline for the in-pod window enumeration. */
const DEFAULT_COMMAND_MS = 10_000

/**
 * True when this tool can run in ACP mode. Checked at create time so a
 * request for an unsupported combination fails before anything is
 * provisioned, rather than as a window that exits on startup.
 */
export function acpAdapterFor(tool: AgentTool): string | undefined {
  return ACP_ADAPTERS[tool]
}

/**
 * Wrap a streamd `ctrl` stream as the duplex the JSON-RPC peer wants. The
 * stream carries newline-delimited JSON in both directions with no framing of
 * its own, which is exactly what `ctrl` was built for (it is how tmux control
 * mode rides the relay too).
 */
function ctrlTransport(child: StreamChild): JsonRpcTransport {
  // A relay stream delivers raw Buffers on TCP read boundaries, which fall
  // wherever the network puts them — including the middle of a multi-byte
  // character. Decoding each chunk on its own would turn a split emoji or CJK
  // glyph into replacement characters in both halves, and because the split can
  // only ever land inside a JSON string the result still parses: the corruption
  // would be silent, and line-buffering downstream cannot undo it. A
  // StringDecoder holds the incomplete tail until its remaining bytes arrive.
  const decoder = new StringDecoder('utf8')
  return {
    write: (data) => child.stdin?.write(data),
    onData: (cb) => child.stdout?.on('data', (chunk) =>
      cb(typeof chunk === 'string' ? chunk : decoder.write(chunk))),
    onClose: (cb) => {
      child.on('exit', () => cb('ctrl stream closed'))
      child.on('error', (err) => cb(`ctrl stream error: ${String(err)}`))
    },
    close: () => {
      child.kill('SIGTERM')
    },
  }
}

/** One live conversation this connection is driving. */
interface Attached {
  handle: string
  tool: AgentTool
  /** Undefined only for the instant between the entry being registered and
   *  the conversation being constructed (see `attach`). */
  conversation?: AcpConversation
  child: StreamChild
  agentSessionId?: string
}

class AcpConnection implements AgentConnection {
  private readonly attached = new Map<string, Attached>()
  private sweepTimer: NodeJS.Timeout | null = null
  private sweeping = false
  private done = false
  private up = false
  /** The last enumeration's handles — what the cadence is judged against. */
  private lastWindows: string[] = []
  /** Consecutive attaches that did not survive a sweep, per handle. Bounds
   *  the fast cadence — see `MAX_FAST_ATTACH_ATTEMPTS`. */
  private readonly attachFailures = new Map<string, number>()
  private readonly sweepMs: number
  private readonly commandTimeoutMs: number
  private readonly log: (msg: string) => void
  private readonly dial: (session: DrivenWorktree, argv: string[]) => StreamChild
  private readonly recordedSessions: () => Promise<Array<{ handle: string; agentSessionId: string }>>

  constructor(
    private readonly session: DrivenWorktree,
    private readonly sink: (obs: AgentObservation) => void,
    deps: AgentConnectDeps,
  ) {
    this.sweepMs = deps.heartbeatIntervalMs ?? DEFAULT_SWEEP_MS
    this.commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_MS
    this.log = deps.log ?? serverLog
    this.dial = deps.dial ?? ((s, argv) => worktreeDriver().dialCtrl(s.jobName, argv))
    this.recordedSessions = deps.recordedSessions ?? (() => Promise.resolve([]))
    void this.sweep().then(() => this.rearm())
  }

  /** (Re)schedule the sweep at the cadence the current state calls for. */
  private rearm(): void {
    if (this.done) return
    const every = this.fastSweepWanted() ? EMPTY_SWEEP_MS : this.sweepMs
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = setInterval(() => void this.sweep().then(() => this.rearm()), every)
  }

  /**
   * Whether some conversation is still on its way up — the state
   * `EMPTY_SWEEP_MS` exists for. Either no window has appeared yet, or one has
   * and this connection is not holding it, having not yet spent its fast
   * attempts on it.
   */
  private fastSweepWanted(): boolean {
    if (this.lastWindows.length === 0) return true
    return this.lastWindows.some((handle) =>
      !this.attached.has(handle)
      && (this.attachFailures.get(handle) ?? 0) < MAX_FAST_ATTACH_ATTEMPTS)
  }

  /**
   * Reconcile the conversations we hold against the pod's ACP windows. The
   * window list is authoritative — it is what the launch exec created and what
   * a restart recreates — so this both attaches to new windows and drops
   * conversations whose window is gone.
   *
   * Doubles as the health probe: the enumeration is a round trip through the
   * relay into the pod's tmux, so its success is the same end-to-end proof the
   * TUI driver's heartbeat gets from `display-message`.
   */
  private async sweep(): Promise<void> {
    if (this.done) return
    // A sweep can outlive its interval (a slow relay round trip), and two
    // overlapping ones would both see a window as unattached and dial it
    // twice — acpd would then displace one of the two, losing whichever
    // client had the live handshake.
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.sweepOnce()
    } finally {
      this.sweeping = false
    }
  }

  private async sweepOnce(): Promise<void> {
    let windows: Array<{ handle: string; tool: AgentTool }>
    try {
      windows = await this.listAcpWindows()
    } catch (err) {
      this.down(`window enumeration failed: ${String(err)}`)
      return
    }
    if (this.done) return

    if (!this.up) {
      this.up = true
      this.sink({ kind: 'up' })
    }

    // Anything still attached a whole sweep later held: that is what separates
    // a real attach from a dial that bounced off a socket acpd had not bound
    // yet, which is gone again within milliseconds.
    for (const handle of this.attached.keys()) this.attachFailures.delete(handle)

    const live = new Set(windows.map((w) => w.handle))
    for (const [handle, entry] of [...this.attached]) {
      if (live.has(handle)) continue
      this.detach(entry, 'window closed')
    }

    const recorded = new Map(
      (await this.recordedSessions().catch(() => [])).map((r) => [r.handle, r.agentSessionId]),
    )
    for (const w of windows) {
      if (this.attached.has(w.handle)) continue
      this.attach(w.handle, w.tool, recorded.get(w.handle))
    }

    // What the cadence is judged against, recorded after the attach loop so a
    // dial that failed synchronously already counts as unattached. A window
    // that has gone keeps no failure tally: the next one to use that name is
    // a new conversation, not the broken one continued.
    this.lastWindows = windows.map((w) => w.handle)
    for (const handle of [...this.attachFailures.keys()]) {
      if (!live.has(handle)) this.attachFailures.delete(handle)
    }

    if (windows.length === 0) {
      // Same rule as the TUI driver: an empty set is never published for a
      // session whose agent simply has not started, because it would read as
      // "every agent exited" and deactivate the worktree's conversations.
      return
    }
    this.publishAgents()
  }

  private async listAcpWindows(): Promise<Array<{ handle: string; tool: AgentTool }>> {
    const { stdout } = await worktreeDriver().exec(
      this.session.jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} list-windows -t yaac -F '#{window_name}'`,
      { maxAttempts: 1, timeout: this.commandTimeoutMs },
    )
    return stdout.split('\n').flatMap((line) => {
      const handle = line.trim()
      const tool = handle === '' ? undefined : agentWindowTool(handle)
      // Only agent windows run acpd; init windows and scratch shells do not.
      return tool === undefined ? [] : [{ handle, tool }]
    })
  }

  private attach(handle: string, tool: AgentTool, resumeSessionId: string | undefined): void {
    let child: StreamChild
    try {
      // socat, not a new streamd kind: `ctrl` already gives us a raw duplex to
      // an argv in the pod, and the agent's endpoint is a UNIX socket rather
      // than a port precisely so it stays out of the auto-forward port scan.
      child = this.dial(this.session, ['socat', '-', `UNIX-CONNECT:${containerAcpSock(handle)}`])
    } catch (err) {
      this.log(`[server] acp-driver ${this.session.worktreeId}/${handle}: dial failed: ${String(err)}`)
      return
    }

    // The entry goes into the map BEFORE the conversation is built: a
    // transport that fails during construction calls `onDown` synchronously,
    // and a `detach` that could not find its entry would leave a dead
    // conversation registered until the window closed.
    const entry: Attached = { handle, tool, child }
    this.attached.set(handle, entry)
    entry.conversation = new AcpConversation({
      transport: ctrlTransport(child),
      cwd: '/workspace',
      ...(resumeSessionId !== undefined ? {
        resumeSessionId,
        // Only a conversation we can already name has a record to read, and it
        // is exactly those that can be mid-turn: a reattach happens on a
        // conversation yaac already recorded.
        recoverInFlight: () => readAcpInFlight(this.recordPath(resumeSessionId)),
      } : {}),
      onSessionId: (agentSessionId) => {
        entry.agentSessionId = agentSessionId
        // acpd opened the record before the agent had an id to give, so rename
        // it onto the one the conversation will be addressed by from now on.
        void adoptLog(this.session, resumeSessionId, agentSessionId, this.log)
        if (entry.conversation) {
          registerAcpConversation(this.session.slug, this.session.worktreeId, { handle, agentSessionId }, entry.conversation)
        }
        // The registry reconciler turns this into the conversation's DB row —
        // ACP mode's replacement for the in-pod hook's session-starts log.
        this.publishAgents()
      },
      onBusy: (busy) => {
        this.sink({ kind: 'status', handle, status: busy ? 'running' : 'waiting' })
      },
      onDown: (reason) => {
        // One conversation's stream dropped; the others are unaffected, and
        // acpd is still holding this one's agent. Drop the entry so the next
        // sweep re-attaches (and, on a reattach, skips the handshake).
        this.log(`[server] acp-driver ${this.session.worktreeId}/${handle}: ${reason}`)
        this.detach(entry, reason)
      },
    })
    // A synchronous failure above already detached; do not re-publish it.
    if (!this.attached.has(handle)) return
    entry.agentSessionId = resumeSessionId
    registerAcpConversation(this.session.slug, this.session.worktreeId, {
      handle,
      ...(resumeSessionId !== undefined ? { agentSessionId: resumeSessionId } : {}),
    }, entry.conversation)
  }

  /** Where acpd is recording one of this worktree's conversations. */
  private recordPath(agentSessionId: string): string {
    return path.join(
      acpLogDir(this.session.slug, this.session.worktreeId),
      `${agentSessionId}.jsonl`,
    )
  }

  private detach(entry: Attached, reason: string): void {
    if (!this.attached.has(entry.handle)) return
    this.attached.delete(entry.handle)
    unregisterAcpConversation(this.session.slug, this.session.worktreeId, {
      handle: entry.handle,
      ...(entry.agentSessionId !== undefined ? { agentSessionId: entry.agentSessionId } : {}),
    })
    entry.conversation?.close()
    this.log(`[server] acp-driver ${this.session.worktreeId}/${entry.handle}: detached (${reason})`)
    // A conversation that dropped is one this connection owes a re-attach, and
    // the drop can land between sweeps — the dial into a window whose acpd is
    // still binding fails milliseconds after a sweep armed the settled
    // cadence. Recompute now rather than waiting out an interval armed for a
    // state this connection is no longer in; the tally is what keeps a window
    // that can never hold an attach from doing this forever.
    this.attachFailures.set(entry.handle, (this.attachFailures.get(entry.handle) ?? 0) + 1)
    this.rearm()
  }

  private publishAgents(): void {
    if (this.done || this.attached.size === 0) return
    const agents: LiveAgent[] = [...this.attached.values()].map((e) => ({
      handle: e.handle,
      tool: e.tool,
      ...(e.agentSessionId !== undefined ? { agentSessionId: e.agentSessionId } : {}),
    }))
    this.sink({ kind: 'live-agents', agents })
    // Each conversation's status is pushed on every turn boundary, but a
    // freshly attached one has never had a boundary — publish its current
    // state so the store is never left with an unclassified conversation.
    //
    // Unless it genuinely has none: a conversation still handshaking, or still
    // reading the record to find out whether the agent it reattached to is
    // mid-turn, has no answer to give. Guessing `waiting` here is what used to
    // paint a working agent idle on every sweep — and stamp it with a waiting
    // spell the sidebar reads as "wants attention". It publishes itself the
    // moment it knows, through `onBusy`.
    for (const e of this.attached.values()) {
      const status = e.conversation?.status
      if (status === undefined) continue
      this.sink({ kind: 'status', handle: e.handle, status })
    }
  }

  private down(reason: string): void {
    if (this.done) return
    this.teardown()
    this.sink({ kind: 'down', reason })
  }

  private teardown(): void {
    this.done = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const entry of [...this.attached.values()]) this.detach(entry, 'connection closed')
  }

  close(): void {
    if (this.done) return
    this.teardown()
  }
}

/**
 * Move a fresh conversation's record from the name acpd was launched with onto
 * the id the agent minted. A rename rather than a copy so acpd's open
 * descriptor keeps writing to the same file, and a no-op on a resume, where the
 * launch name was already the final one.
 */
async function adoptLog(
  session: DrivenWorktree,
  launchedAs: string | undefined,
  agentSessionId: string,
  log: (msg: string) => void,
): Promise<void> {
  const provisional = launchedAs ?? session.worktreeId
  if (provisional === agentSessionId) return
  const dir = acpLogDir(session.slug, session.worktreeId)
  try {
    await fs.rename(path.join(dir, `${provisional}.jsonl`), path.join(dir, `${agentSessionId}.jsonl`))
  } catch (err) {
    // Losing the adoption costs this conversation its history on the next
    // attach, not the conversation itself — so it is logged, not fatal.
    log(`[server] acp-driver ${session.worktreeId}: could not adopt log for ${agentSessionId}: ${String(err)}`)
  }
}

/** Poll the registry until the connection's sweep has attached `handle`. */
async function waitForConversation(
  slug: string,
  worktreeId: string,
  handle: string,
  timeoutMs: number,
): Promise<AcpConversation> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = acpConversationByHandle(slug, worktreeId, handle)
    if (found !== undefined) return found
    if (Date.now() >= deadline) {
      throw new Error(`no ACP conversation attached on ${handle} after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export const acpDriver: AgentDriver = {
  mode: 'acp',

  /**
   * The tmux window's command: acpd supervising the tool's ACP adapter, with
   * the conversation's socket named for the window it runs in.
   *
   * No `--resume` flag: resuming an ACP conversation is a protocol call
   * (`session/load`) the client makes after connecting, not a launch argument.
   * The whole string is embedded in a single-quoted `respawn-window '<cmd>'`,
   * so it deliberately contains no quotes.
   */
  launchCmd(spec: AgentLaunchSpec): string {
    const adapter = acpAdapterFor(spec.tool)
    if (adapter === undefined) {
      throw new Error(`no ACP adapter for ${spec.tool}`)
    }
    const model = spec.model !== undefined ? ` --model ${spec.model}` : ''
    // The record is named for the CONVERSATION, not the window: a window name
    // is a slot, and a restart that drops an earlier conversation shifts every
    // later one down a slot — which under slot-naming would truncate a live
    // conversation's history onto another's file. On a resume the id is
    // already known and this is its final name; on a fresh create the agent has
    // not minted one yet, so it starts under the worktree id and is adopted
    // once `session/new` answers (see `adoptLog`).
    return `node /opt/yaac/acpd/main.js --sock ${containerAcpSock(spec.windowName)}`
      + ` --log ${containerAcpLog(spec.agentSessionId)} -- ${adapter}${model}`
  },

  connect(session, sink, deps = {}): AgentConnection {
    return new AcpConnection(session, sink, deps)
  },

  /**
   * Deliver a user message. Resolves once the turn has been *dispatched*, not
   * once the agent answers — the pane is fed by events, and session create
   * must not block for the length of a turn.
   *
   * Waits for the conversation to exist because the only caller that races it
   * is session create, which runs the moment the agent window is made and
   * before the driver's sweep has attached to it.
   */
  async deliverPrompt(session: DrivenWorktree, handle: string, text: string): Promise<void> {
    const conversation = await waitForConversation(
      session.slug, session.worktreeId, handle, PROMPT_ATTACH_TIMEOUT_MS,
    )
    void conversation.prompt(text).catch((err: unknown) => {
      serverLog(`[server] acp-driver ${session.worktreeId}/${handle}: prompt failed: ${String(err)}`)
    })
  },
}
