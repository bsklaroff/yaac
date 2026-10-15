/**
 * The `acp` driver: a coding agent speaking the Agent Client Protocol
 * (JSON-RPC over stdio) instead of rendering a TUI (docs/agent-modes.md).
 *
 * The agent still runs in a tmux window so it survives a closed tab, a
 * dropped relay or a server restart. A streamd `ctrl` stream would kill its
 * child on disconnect, and a PTY would corrupt the protocol, so the window
 * runs `acpd`, which owns the agent's stdio and republishes it on a UNIX
 * socket that can be attached and detached freely:
 *
 *     tmux window                                   this driver
 *     ┌─────────────────────────────┐               ┌──────────────────┐
 *     │ acpd ── stdio ── ACP agent  │               │ AcpConversation  │
 *     │   └── /tmp/yaac-acp/<w>.sock│◄──ctrl+socat──┤ (JSON-RPC peer)  │
 *     └─────────────────────────────┘               └──────────────────┘
 *
 * Because a conversation is still a tmux window, launch, restart,
 * window-close teardown and session GC work unchanged; the webapp just
 * renders a chat pane instead of attaching a PTY.
 *
 * Status is `running` while a `session/prompt` is in flight or the adapter
 * reports itself working (which covers turns it starts on its own, except
 * under opencode), `waiting` otherwise. Across reconnects acpd's record tells whether the old
 * connection's turn is still running.
 */

import { StringDecoder } from 'node:string_decoder'
import type { StreamChild, WorkspacePaths } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { serverLog } from '#lib/log'
import { shellQuote } from '#lib/shell'
import { AcpConversation } from './acp-client'
import { readAcpRecovery } from './acp-log'
import { type JsonRpcTransport } from './acp-jsonrpc'
import {
  BOOT_SUBSCRIPTION_PREFIX,
  ControlModeConnection,
  PLACEHOLDER_FORMAT,
} from './control-mode'
import { agentWindowTool } from './agent-tools'
import {
  dropAcpQueues,
  parkAcpQueue,
  registerAcpConversation,
  takeAcpQueue,
  unregisterAcpConversation,
  whenAcpConversation,
} from './acp-registry'
import { acpAdapterFor, acpModelIsProtocol } from './acp-adapters'
import { assertLaunchableModel } from './agent-command'
import type {
  AgentConnectDeps,
  AgentConnection,
  AgentDriver,
  AgentLaunchSpec,
  AgentObservation,
  DrivenWorkspace,
  LiveAgent,
} from './drivers'
import { agentSessionIdSchema, type AgentTool, type PermissionMode } from '@yaac/shared/types'

/**
 * One conversation's acpd socket inside the workspace, named for its tmux
 * window (`claude`, `claude-2`) so a reattach can find it from the window
 * list. The directory comes from the driver (`WorkspacePaths.acpSockDir`)
 * because one fixed path is safe per pod but not shared by host processes.
 */
function acpSockPath(paths: Pick<WorkspacePaths, 'acpSockDir'>, handle: string): string {
  return `${paths.acpSockDir}/${handle}.sock`
}

/** One conversation's ACP log inside the workspace, named for the
 *  conversation rather than its window (see `launchCmd`). */
function acpLogPath(paths: Pick<WorkspacePaths, 'acpLogDir'>, name: string): string {
  return `${paths.acpLogDir}/${name}.jsonl`
}

/**
 * Delay before re-dialing a window whose acpd dropped the dial. acpd binds
 * its socket a moment after tmux respawns the window into it, so the first
 * dial often finds nothing. Until a dial lands there is no handshake,
 * conversation id, row or chat pane, and session create waits on it to
 * deliver the initial prompt.
 */
const ATTACH_RETRY_MS = 1_000

/**
 * Re-dials of one window before it waits for the heartbeat's re-list. A
 * window failing this often is broken (acpd crashed, socket gone).
 *
 * Generous because giving up early delays a real conversation by a whole
 * heartbeat, while ten extra dials are cheap. A healthy window is
 * attachable in milliseconds; this is headroom for a loaded gVisor node.
 */
export const MAX_FAST_ATTACH_ATTEMPTS = 10

/** How long `deliverPrompt` waits for a conversation to finish its handshake
 *  before giving up. Generous: it covers an adapter's cold start. */
const PROMPT_ATTACH_TIMEOUT_MS = 60_000

/**
 * Pane option holding `<pane pid>:<session id>` once a fresh conversation's
 * `session/new` answers. A reattach needs the id, and a prewarmed spare's
 * conversation has no row to recover it from after a server restart; the
 * pane outlives the server.
 */
const SESSION_PANE_OPTION = '@yaac-acp-session'

/** Every open connection, so a recorded posture change reaches the ones
 *  driving that workspace. */
const openConnections = new Set<AcpConnection>()

/**
 * Wrap a streamd `ctrl` stream as the JSON-RPC peer's transport. `ctrl`
 * carries newline-delimited JSON with no framing of its own.
 */
function ctrlTransport(child: StreamChild): JsonRpcTransport {
  // Chunks split on TCP boundaries, possibly mid-character. Decoding each
  // chunk alone would silently corrupt multi-byte characters inside JSON
  // strings; StringDecoder holds the incomplete tail.
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
  /** The window's process when attached; a respawn replaces it. */
  panePid: string
  /** Undefined only briefly, between registration and construction (see
   *  `attach`). */
  conversation?: AcpConversation
  child: StreamChild
  agentSessionId?: string
  model?: string
  modelName?: string
  modeId?: string
  effort?: string
}

/**
 * One workspace's conversations, tracked through a tmux control-mode client
 * of its own (`ControlModeConnection`): a window added or closed is pushed
 * as a notification, and an agent window still running create's
 * placeholder is watched through a subscription until acpd replaces it.
 */
class AcpConnection extends ControlModeConnection {
  private readonly attached = new Map<string, Attached>()
  /** Pending re-dials, by handle; see `ATTACH_RETRY_MS`. */
  private readonly retries = new Map<string, NodeJS.Timeout>()
  /** Consecutive attaches per handle that did not survive until the next
   *  re-list; see `MAX_FAST_ATTACH_ATTEMPTS`. */
  private readonly attachFailures = new Map<string, number>()
  /** Placeholder panes with a boot subscription. */
  private readonly booting = new Set<string>()
  private syncing: Promise<void> | null = null
  private syncAgain = false
  private readonly recordedSessions: () => Promise<Array<{ handle: string; agentSessionId: string }>>
  private readonly readPermissionMode: () => Promise<PermissionMode | undefined>
  private readonly readLaunchModel: (tool: AgentTool) => Promise<string | undefined>
  private readonly readEffort: () => Promise<string | undefined>
  /**
   * The effort a new or loaded conversation is put at: the row's, read at
   * connect, then whatever a conversation here last reported (the row
   * follows those too).
   */
  private effort: string | undefined
  /**
   * The posture, read at connect (and on each heartbeat until a read
   * succeeds) and then followed through `setAcpPermissionMode`. Cached
   * because a conversation needs it synchronously when an ask arrives.
   *
   * Starts unknown, not `bypass`: otherwise a failed read could lock a
   * `manual` workspace into auto-answering at the handshake.
   */
  permissionMode: PermissionMode | undefined

  constructor(session: DrivenWorkspace, sink: (obs: AgentObservation) => void, deps: AgentConnectDeps) {
    super(session, sink, deps, 'acp-driver')
    this.recordedSessions = deps.recordedSessions ?? (() => Promise.resolve([]))
    this.readPermissionMode = deps.permissionMode ?? (() => Promise.resolve('bypass'))
    this.readLaunchModel = deps.launchModel ?? (() => Promise.resolve(undefined))
    this.readEffort = deps.effort ?? (() => Promise.resolve(undefined))
    openConnections.add(this)
    this.start()
  }

  /** Before any attach, so new conversations handshake with the posture
   *  and effort. An unreadable effort leaves the adapter's own. */
  protected async init(): Promise<void> {
    await this.loadPermissionMode()
    this.effort = await this.readEffort().catch(() => undefined)
  }

  /** Until a read succeeds; see `permissionMode`. */
  protected beforeHeartbeat(): void {
    if (this.permissionMode === undefined) void this.loadPermissionMode()
  }

  /** A failed read leaves the posture unknown, so every ask is forwarded,
   *  and the next heartbeat reads again. */
  private async loadPermissionMode(): Promise<void> {
    try {
      this.permissionMode ??= await this.readPermissionMode()
    } catch (err) {
      this.log(`[server] acp-driver ${this.session.workspaceId}: could not read the`
        + ` permission posture: ${String(err)}`)
    }
  }

  /** acpd replaced the placeholder. */
  protected onBooted(paneId: string): void {
    this.booting.delete(paneId)
  }

  /** acp panes carry only boot subscriptions. */
  protected onSubscription(): void {}

  /**
   * Reconcile held conversations against the workspace's agent windows,
   * which are authoritative (the launch creates them, a restart recreates
   * them): attach new windows and drop conversations whose window is gone.
   *
   * Serialized: overlapping passes would dial a window twice, and acpd
   * would displace whichever client held the live handshake. A call during
   * a pass runs one more after it.
   */
  protected sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true
      return this.syncing
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false
          await this.syncOnce()
        } while (this.syncAgain && !this.done)
      } finally {
        this.syncing = null
      }
    })()
    return this.syncing
  }

  private async syncOnce(): Promise<void> {
    const listed = await this.send(`list-windows -t yaac -F '#{window_name}\t#{pane_id}\t${PLACEHOLDER_FORMAT}`
      + `\t#{pane_pid}\t#{${SESSION_PANE_OPTION}}'`)
    if (this.done) return
    const windows = listed.split('\n').flatMap((line) => {
      const [handle = '', paneId = '', placeholder, pid = '', session = ''] = line.split('\t')
      const tool = agentWindowTool(handle)
      // Only agent windows run acpd; init windows and scratch shells do not.
      if (tool === undefined) return []
      // Only a session minted by the pane's current process; a respawn keeps
      // the option but replaces the process.
      const sessionPid = session.slice(0, session.indexOf(':'))
      const liveSession = sessionPid !== '' && sessionPid === pid ? session.slice(sessionPid.length + 1) : undefined
      return [{ handle, tool, paneId, pid, placeholder: placeholder === '1', liveSession }]
    })

    // Still attached at a re-list means the attach held, not a dial that
    // bounced before acpd bound its socket.
    for (const handle of this.attached.keys()) this.attachFailures.delete(handle)
    const live = new Map(windows.map((w) => [w.handle, w]))
    for (const [handle, entry] of [...this.attached]) {
      const w = live.get(handle)
      if (w === undefined) this.detach(entry, 'window closed')
      // A respawned agent's old stream normally closes and says so, but one
      // that died silently would hold the window's name forever, so the new
      // acpd would never be dialed. Handled like that close.
      else if (w.pid !== entry.panePid) this.detach(entry, 'agent respawned', { keepQueue: true })
    }
    // A new window with a vanished one's name is a new conversation.
    for (const handle of [...this.attachFailures.keys()]) {
      if (live.has(handle)) continue
      this.attachFailures.delete(handle)
      clearTimeout(this.retries.get(handle))
      this.retries.delete(handle)
    }

    for (const w of windows) {
      if (!w.placeholder || this.booting.has(w.paneId)) continue
      this.booting.add(w.paneId)
      await this.send(`refresh-client -B '${BOOT_SUBSCRIPTION_PREFIX}${w.paneId.replace('%', '')}:${w.paneId}:${PLACEHOLDER_FORMAT}'`)
      if (this.done) return
    }

    const sessions = await this.recordedSessions().catch(() => undefined)
    if (this.done) return
    const recorded = new Map((sessions ?? []).map((r) => [r.handle, r.agentSessionId]))
    // A queue parked for a conversation whose window is gone has no taker.
    // Without the recorded sessions that cannot be told, so nothing is
    // dropped.
    if (sessions !== undefined) {
      dropAcpQueues(this.session.projectId, this.session.workspaceId, new Set(
        windows.flatMap((w) => {
          const id = recorded.get(w.handle)
          return id === undefined ? [] : [id]
        }),
      ))
    }
    for (const w of windows) {
      if (w.placeholder || this.attached.has(w.handle) || this.retries.has(w.handle)) continue
      this.attach(w.handle, w.tool, recorded.get(w.handle) ?? w.liveSession, { paneId: w.paneId, pid: w.pid })
    }
    // As in the TUI driver: never publish an empty set, which would read as
    // "every agent exited" before the agent has even started.
    this.publishAgents()
  }

  /** Re-dial a window after `ATTACH_RETRY_MS`, up to the fast-attempt cap. */
  private retry(handle: string): void {
    if (this.done || this.retries.has(handle)) return
    const failures = (this.attachFailures.get(handle) ?? 0) + 1
    this.attachFailures.set(handle, failures)
    if (failures >= MAX_FAST_ATTACH_ATTEMPTS) return
    this.retries.set(handle, setTimeout(() => {
      this.retries.delete(handle)
      void this.resync()
    }, ATTACH_RETRY_MS))
  }

  private attach(
    handle: string,
    tool: AgentTool,
    resumeSessionId: string | undefined,
    pane: { paneId: string; pid: string },
  ): void {
    let child: StreamChild
    try {
      // socat over `ctrl` gives a raw duplex to the socket. The endpoint is a
      // UNIX socket so it stays out of the auto-forward port scan.
      const paths = workspaceDriver().workspacePaths(this.session.jobName)
      child = this.dial(this.session, [
        'socat', '-', `UNIX-CONNECT:${acpSockPath(paths, handle)}`,
      ])
    } catch (err) {
      this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: dial failed: ${String(err)}`)
      this.retry(handle)
      return
    }

    // Register the entry before constructing the conversation: a transport
    // failing during construction calls `onDown` synchronously, and `detach`
    // must find the entry.
    const entry: Attached = { handle, tool, panePid: pane.pid, child }
    const panePid = pane.pid !== '' ? { panePid: pane.pid } : {}
    this.attached.set(handle, entry)
    const profile = acpAdapterFor(tool)
    // Messages the previous connection to this conversation still had queued.
    const queue = resumeSessionId === undefined
      ? []
      : takeAcpQueue(this.session.projectId, this.session.workspaceId, resumeSessionId)
    entry.conversation = new AcpConversation({
      transport: ctrlTransport(child),
      queue,
      cwd: workspaceDriver().workspacePaths(this.session.jobName).workspaceDir,
      tailFile: async (file, bytes) => (await workspaceDriver().exec(
        this.session.jobName,
        `tail -c ${String(bytes)} -- ${shellQuote(file)}`,
        { maxAttempts: 1, timeout: this.commandTimeoutMs },
      )).stdout,
      permissionMode: () => this.permissionMode,
      effort: () => this.effort,
      profile,
      // Without one the adapter runs its own default, for pi possibly a
      // provider whose key the proxy does not swap.
      ...(acpModelIsProtocol(profile) ? { launchModel: () => this.readLaunchModel(tool) } : {}),
      ...(resumeSessionId !== undefined ? {
        resumeSessionId,
        // Only a recorded conversation can be mid-turn on attach, and only
        // it has a record to read.
        recover: () => readAcpRecovery({
          projectId: this.session.projectId, workspaceId: this.session.workspaceId, agentSessionId: resumeSessionId,
        }),
      } : {}),
      onSessionId: (agentSessionId) => {
        // The agent mints the id, and it is later joined into paths and a
        // launch line, so a malformed one is not recorded.
        if (!agentSessionIdSchema.safeParse(agentSessionId).success) {
          this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: not recording malformed id ${JSON.stringify(agentSessionId.slice(0, 200))}`)
          return
        }
        entry.agentSessionId = agentSessionId
        // acpd opened the record before the id existed; rename it.
        void adoptLog(this.session, resumeSessionId, agentSessionId, this.log)
        void this.send(`set-option -p -t ${pane.paneId} ${SESSION_PANE_OPTION} '${pane.pid}:${agentSessionId}'`)
          .catch((err: unknown) => {
            this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: could not note the session on its pane: ${String(err)}`)
          })
        if (entry.conversation) {
          registerAcpConversation(this.session.projectId, this.session.workspaceId, { handle, agentSessionId, ...panePid }, entry.conversation)
        }
        // The registry reconciler turns this into the conversation's row.
        this.publishAgents()
      },
      onModel: (model, name) => {
        entry.model = model
        entry.modelName = name
        this.publishAgents()
      },
      onModeId: (modeId) => {
        entry.modeId = modeId
        this.publishAgents()
      },
      onEffort: (effort) => {
        entry.effort = effort
        this.effort = effort
        this.publishAgents()
      },
      onStatus: () => {
        const status = entry.conversation?.status
        if (status !== undefined) this.sink({ kind: 'status', handle, status })
      },
      onDown: (reason) => {
        // Only this conversation's stream dropped, and acpd still holds its
        // agent (or has yet to bind). A re-dial attaches without a handshake.
        this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: ${reason}`)
        this.detach(entry, reason, { keepQueue: true })
        this.retry(handle)
      },
    })
    // A synchronous failure above already detached; do not re-publish it.
    if (!this.attached.has(handle)) return
    entry.agentSessionId = resumeSessionId
    registerAcpConversation(this.session.projectId, this.session.workspaceId, {
      handle,
      ...(resumeSessionId !== undefined ? { agentSessionId: resumeSessionId } : {}),
      ...panePid,
    }, entry.conversation)
  }

  /**
   * `keepQueue` is for a dropped connection: acpd keeps the agent, so the
   * conversation that replaces this one sends what was queued. A closed
   * window ends the conversation, and its queue with it. A workspace stop
   * parks too; the status watcher retiring it discards what was parked
   * (`dropAcpQueues`).
   */
  private detach(entry: Attached, reason: string, { keepQueue = false } = {}): void {
    if (!this.attached.has(entry.handle)) return
    this.attached.delete(entry.handle)
    unregisterAcpConversation(this.session.projectId, this.session.workspaceId, {
      handle: entry.handle,
      ...(entry.agentSessionId !== undefined ? { agentSessionId: entry.agentSessionId } : {}),
    })
    if (keepQueue && entry.conversation !== undefined && entry.agentSessionId !== undefined) {
      parkAcpQueue(this.session.projectId, this.session.workspaceId, entry.agentSessionId, entry.conversation.takeQueue())
    }
    entry.conversation?.close()
    this.log(`[server] acp-driver ${this.session.workspaceId}/${entry.handle}: detached (${reason})`)
  }

  private publishAgents(): void {
    if (this.done || this.attached.size === 0) return
    const agents: LiveAgent[] = [...this.attached.values()].map((e) => ({
      handle: e.handle,
      tool: e.tool,
      ...(e.agentSessionId !== undefined ? { agentSessionId: e.agentSessionId } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.modelName !== undefined ? { modelName: e.modelName } : {}),
      ...(e.modeId !== undefined ? { reportedMode: e.modeId } : {}),
      ...(e.effort !== undefined ? { reportedEffort: e.effort } : {}),
    }))
    this.sink({ kind: 'live-agents', agents })
    // A newly attached conversation has had no turn boundary yet, so publish
    // its status. Skip unclassified ones (handshaking or recovering):
    // guessing `waiting` would mark a working agent as wanting attention.
    // They publish through `onStatus` once known.
    for (const e of this.attached.values()) {
      const status = e.conversation?.status
      if (status === undefined) continue
      this.sink({ kind: 'status', handle: e.handle, status })
    }
  }

  protected cleanup(): void {
    openConnections.delete(this)
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    // The watcher reconnects after a `down`, so this parks like a dropped
    // conversation; only the watcher knows whether the workspace stopped.
    for (const entry of [...this.attached.values()]) this.detach(entry, 'connection closed', { keepQueue: true })
  }
}

/**
 * Rename a fresh conversation's record from its launch name to the id the
 * agent minted. A rename keeps acpd's open descriptor writing to the same
 * file; a no-op on a resume. The id was validated by `onSessionId`, and
 * `rename` never follows its last segment, so a planted link is moved or
 * replaced, never written through.
 */
async function adoptLog(
  session: DrivenWorkspace,
  launchedAs: string | undefined,
  agentSessionId: string,
  log: (msg: string) => void,
): Promise<void> {
  const provisional = launchedAs ?? session.workspaceId
  if (provisional === agentSessionId) return
  const dir = acpLogDir(session.projectId, session.workspaceId)
  try {
    await fs.rename(path.join(dir, `${provisional}.jsonl`), path.join(dir, `${agentSessionId}.jsonl`))
  } catch (err) {
    // Only costs this conversation its history on the next attach.
    log(`[server] acp-driver ${session.workspaceId}: could not adopt log for ${agentSessionId}: ${String(err)}`)
  }
}

/**
 * Follow a workspace's recorded posture change (`permission-mode-changed`)
 * in its open connections, which decide from it who answers an ask.
 */
export function setAcpPermissionMode(projectId: string, workspaceId: string, permissionMode: PermissionMode): void {
  for (const c of openConnections) {
    if (c.session.projectId === projectId && c.session.workspaceId === workspaceId) c.permissionMode = permissionMode
  }
}

export const acpDriver: AgentDriver = {
  mode: 'acp',

  /**
   * The tmux window's command: acpd supervising the tool's ACP adapter, with
   * the socket named for the window. Per-adapter argv and env come from the
   * adapter profile. The string is embedded in a single-quoted
   * `respawn-window '<cmd>'`, so it has no quotes beyond those escaped
   * inside env JSON values.
   *
   * No `--resume`: resuming is a `session/load` call after connecting. No
   * posture either (except opencode's env): the adapter is told it with
   * `session/set_mode` after the handshake, which avoids two sources for
   * one answer across reconnects.
   */
  launchCmd(spec: AgentLaunchSpec): string {
    assertLaunchableModel(spec.tool, spec.model)
    const adapter = acpAdapterFor(spec.tool)
    // Name the record for the conversation, not the window: window names are
    // slots that shift when a restart drops an earlier conversation, which
    // would mix histories. A fresh create starts under the workspace id and
    // is renamed once `session/new` answers (see `adoptLog`). `--cwd` is
    // passed because acpd cannot know the checkout path.
    return [
      ...adapter.env(spec),
      `node ${spec.paths.acpdEntry}`,
      `--sock ${acpSockPath(spec.paths, spec.windowName)}`,
      `--log ${acpLogPath(spec.paths, spec.agentSessionId)}`,
      `--cwd ${spec.paths.workspaceDir}`,
      '--',
      ...adapter.argv,
    ].join(' ')
  },

  connect(session, sink, deps = {}): AgentConnection {
    return new AcpConnection(session, sink, deps)
  },

  /**
   * Deliver a user message. Resolves once dispatched, not when the agent
   * answers, so session create does not block for a turn. Waits for the
   * conversation's handshake, since session create runs before the
   * connection has found the new window.
   */
  async deliverPrompt(session: DrivenWorkspace, handle: string, text: string): Promise<void> {
    const conversation = await whenAcpConversation(
      session.projectId, session.workspaceId, handle, PROMPT_ATTACH_TIMEOUT_MS,
    )
    if (conversation === undefined) {
      throw new Error(`no ACP conversation attached on ${handle} after ${String(PROMPT_ATTACH_TIMEOUT_MS)}ms`)
    }
    void conversation.prompt(text).catch((err: unknown) => {
      serverLog(`[server] acp-driver ${session.workspaceId}/${handle}: prompt failed: ${String(err)}`)
    })
  },
}
