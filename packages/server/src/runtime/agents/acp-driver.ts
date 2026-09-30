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
 * Status is exact: `running` while a `session/prompt` is in flight,
 * `waiting` once the agent answers. Across reconnects acpd's record tells
 * whether the old connection's turn is still running.
 */

import { StringDecoder } from 'node:string_decoder'
import { type StreamChild, type WorkspacePaths } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import { AcpConversation } from './acp-client'
import { readAcpInFlight, readAcpModeId, readAcpPendingPermissions, type AcpRecordRef } from './acp-log'
import { tmuxCmd } from './agent-command'
import { agentWindowTool } from './agent-tools'
import {
  acpConversationByHandle,
  registerAcpConversation,
  stashAcpLaunchModel,
  takeAcpLaunchModel,
  unregisterAcpConversation,
} from './acp-registry'
import { acpAdapterFor, acpLaunchModel, acpModelIsProtocol } from './acp-adapters'
import type { JsonRpcTransport } from './acp-jsonrpc'
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

/** How often the connection re-lists the workspace's ACP windows. */
const DEFAULT_SWEEP_MS = 20_000

/**
 * Sweep interval while some known window is not attached. Covers two cases
 * of a conversation starting up: the agent window is created after the pod
 * is Ready, and acpd binds its socket a moment after tmux spawns it, so the
 * first dial often finds nothing. Until a dial lands there is no handshake,
 * conversation id, row or chat pane, and session create waits on it to
 * deliver the initial prompt.
 *
 * Falls back to `DEFAULT_SWEEP_MS` once every window is attached or has used
 * its `MAX_FAST_ATTACH_ATTEMPTS`.
 */
const EMPTY_SWEEP_MS = 1_000

/**
 * Attach failures after which a window drops to the slow sweep. A window
 * failing this often is broken (acpd crashed, socket gone), and fast retries
 * would cost an exec and dial per second for the pod's life; it is still
 * retried every `DEFAULT_SWEEP_MS`.
 *
 * Generous because giving up early delays a real conversation by a full
 * sweep, while ten extra dials are cheap. A healthy window is attachable in
 * milliseconds; this is headroom for a loaded gVisor node.
 */
export const MAX_FAST_ATTACH_ATTEMPTS = 10

/** How long `deliverPrompt` waits for a conversation to finish its handshake
 *  before giving up. Generous: it covers an adapter's cold start. */
const PROMPT_ATTACH_TIMEOUT_MS = 60_000

/** Deadline for the in-pod window enumeration. */
const DEFAULT_COMMAND_MS = 10_000

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
  /** Undefined only briefly, between registration and construction (see
   *  `attach`). */
  conversation?: AcpConversation
  child: StreamChild
  agentSessionId?: string
  model?: string
  modelName?: string
  modeId?: string
}

class AcpConnection implements AgentConnection {
  private readonly attached = new Map<string, Attached>()
  private sweepTimer: NodeJS.Timeout | null = null
  private sweeping = false
  private done = false
  private up = false
  /** Handles from the last enumeration; drives the sweep cadence. */
  private lastWindows: string[] = []
  /** Consecutive attaches per handle that did not survive a sweep; see
   *  `MAX_FAST_ATTACH_ATTEMPTS`. */
  private readonly attachFailures = new Map<string, number>()
  private readonly sweepMs: number
  private readonly commandTimeoutMs: number
  private readonly log: (msg: string) => void
  private readonly dial: (session: DrivenWorkspace, argv: string[]) => StreamChild
  private readonly recordedSessions: () => Promise<Array<{ handle: string; agentSessionId: string }>>
  private readonly readPermissionMode: () => Promise<PermissionMode | undefined>
  /**
   * The posture as of the last successful sweep read. Cached because a
   * conversation needs it synchronously when an ask arrives; refreshed every
   * sweep so a rewritten row is picked up.
   *
   * Starts unknown, not `bypass`: otherwise a failed first read could lock
   * a `manual` workspace into auto-answering at the handshake.
   */
  private permissionMode: PermissionMode | undefined

  constructor(
    private readonly session: DrivenWorkspace,
    private readonly sink: (obs: AgentObservation) => void,
    deps: AgentConnectDeps,
  ) {
    this.sweepMs = deps.heartbeatIntervalMs ?? DEFAULT_SWEEP_MS
    this.commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_MS
    this.log = deps.log ?? serverLog
    this.dial = deps.dial ?? ((s, argv) => workspaceDriver().dialCtrl(s.jobName, argv))
    this.recordedSessions = deps.recordedSessions ?? (() => Promise.resolve([]))
    this.readPermissionMode = deps.permissionMode ?? (() => Promise.resolve('bypass'))
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
   * Whether a conversation is still starting up (see `EMPTY_SWEEP_MS`): no
   * window yet, or an unattached window with fast attempts left.
   */
  private fastSweepWanted(): boolean {
    if (this.lastWindows.length === 0) return true
    return this.lastWindows.some((handle) =>
      !this.attached.has(handle)
      && (this.attachFailures.get(handle) ?? 0) < MAX_FAST_ATTACH_ATTEMPTS)
  }

  /**
   * Reconcile held conversations against the workspace's ACP windows, which
   * are authoritative (the launch creates them, a restart recreates them):
   * attach new windows and drop conversations whose window is gone.
   *
   * Also the health probe: listing windows is a round trip to the
   * workspace's tmux, like the TUI driver's `display-message` heartbeat.
   */
  private async sweep(): Promise<void> {
    if (this.done) return
    // Overlapping sweeps would dial a window twice, and acpd would displace
    // whichever client held the live handshake.
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

    // Still attached a full sweep later means the attach held, not a dial
    // that bounced before acpd bound its socket.
    for (const handle of this.attached.keys()) this.attachFailures.delete(handle)

    const live = new Set(windows.map((w) => w.handle))
    for (const [handle, entry] of [...this.attached]) {
      if (live.has(handle)) continue
      this.detach(entry, 'window closed')
    }

    const recorded = new Map(
      (await this.recordedSessions().catch(() => [])).map((r) => [r.handle, r.agentSessionId]),
    )
    // Refresh before attaching so new conversations handshake with the
    // current posture. On a failed read keep the last known value (falling
    // back to `bypass` would silently stop enforcing the user's choice);
    // before any successful read it stays unknown and every ask is forwarded.
    try {
      this.permissionMode = await this.readPermissionMode()
    } catch (err) {
      this.log(`[server] acp-driver ${this.session.workspaceId}: could not read the`
        + ` permission posture: ${String(err)}`)
    }
    for (const w of windows) {
      if (this.attached.has(w.handle)) continue
      this.attach(w.handle, w.tool, recorded.get(w.handle))
    }

    // Recorded after the attach loop so a synchronous dial failure counts as
    // unattached. A vanished window's failure tally is dropped; a new window
    // with that name is a new conversation.
    this.lastWindows = windows.map((w) => w.handle)
    for (const handle of [...this.attachFailures.keys()]) {
      if (!live.has(handle)) this.attachFailures.delete(handle)
    }

    if (windows.length === 0) {
      // As in the TUI driver: never publish an empty set, which would read
      // as "every agent exited" before the agent has even started.
      return
    }
    this.publishAgents()
  }

  private async listAcpWindows(): Promise<Array<{ handle: string; tool: AgentTool }>> {
    const driver = workspaceDriver()
    const { stdout } = await driver.exec(
      this.session.jobName,
      `${tmuxCmd(driver.workspacePaths(this.session.jobName))} `
      + "list-windows -t yaac -F '#{window_name}'",
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
      // socat over `ctrl` gives a raw duplex to the socket. The endpoint is a
      // UNIX socket so it stays out of the auto-forward port scan.
      const paths = workspaceDriver().workspacePaths(this.session.jobName)
      child = this.dial(this.session, [
        'socat', '-', `UNIX-CONNECT:${acpSockPath(paths, handle)}`,
      ])
    } catch (err) {
      this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: dial failed: ${String(err)}`)
      return
    }

    // Register the entry before constructing the conversation: a transport
    // failing during construction calls `onDown` synchronously, and `detach`
    // must find the entry.
    const entry: Attached = { handle, tool, child }
    this.attached.set(handle, entry)
    // The launch-time model was parked under the launch id: the recorded id
    // on a resume, the workspace id on a fresh create.
    const launchId = resumeSessionId ?? this.session.workspaceId
    const profile = acpAdapterFor(tool)
    // Only protocol-model adapters have one parked, and only the first
    // attach takes it.
    const launchModel = acpModelIsProtocol(profile)
      ? takeAcpLaunchModel(launchId)
      : undefined
    if (acpModelIsProtocol(profile) && launchModel === undefined && resumeSessionId === undefined) {
      // The server restarted between launch and attach, so the adapter runs
      // its own default (for pi, possibly a provider whose key the proxy
      // does not swap). Log it, since nothing else will.
      this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: no launch model`
        + ' was parked for this conversation — the agent runs its own default')
    }
    entry.conversation = new AcpConversation({
      transport: ctrlTransport(child),
      cwd: workspaceDriver().workspacePaths(this.session.jobName).workspaceDir,
      permissionMode: () => this.permissionMode,
      profile,
      ...(launchModel !== undefined ? { launchModel } : {}),
      ...(resumeSessionId !== undefined ? {
        resumeSessionId,
        // Only a recorded conversation can be mid-turn on attach, and only
        // it has a record to read.
        recoverInFlight: () => readAcpInFlight(this.record(resumeSessionId)),
        recoverPendingPermissions: () => readAcpPendingPermissions(this.record(resumeSessionId)),
        recoverModeId: () => readAcpModeId(this.record(resumeSessionId)),
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
        if (entry.conversation) {
          registerAcpConversation(this.session.slug, this.session.workspaceId, { handle, agentSessionId }, entry.conversation)
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
      onBusy: (busy) => {
        // Ask the conversation: a turn parked on a permission ask is busy
        // but `waiting`. The fallback only covers construction.
        this.sink({
          kind: 'status',
          handle,
          status: entry.conversation?.status ?? (busy ? 'running' : 'waiting'),
        })
      },
      onPermissionPending: () => {
        // The agent went from working to waiting on the user (or back).
        const status = entry.conversation?.status
        if (status !== undefined) this.sink({ kind: 'status', handle, status })
      },
      onDown: (reason) => {
        // Only this conversation's stream dropped, and acpd still holds its
        // agent. The next sweep re-attaches without a handshake.
        this.log(`[server] acp-driver ${this.session.workspaceId}/${handle}: ${reason}`)
        this.detach(entry, reason)
      },
    })
    // A synchronous failure above already detached; do not re-publish it.
    if (!this.attached.has(handle)) return
    entry.agentSessionId = resumeSessionId
    registerAcpConversation(this.session.slug, this.session.workspaceId, {
      handle,
      ...(resumeSessionId !== undefined ? { agentSessionId: resumeSessionId } : {}),
    }, entry.conversation)
  }

  /** The record acpd keeps for one of this workspace's conversations. */
  private record(agentSessionId: string): AcpRecordRef {
    return { slug: this.session.slug, workspaceId: this.session.workspaceId, agentSessionId }
  }

  private detach(entry: Attached, reason: string): void {
    if (!this.attached.has(entry.handle)) return
    this.attached.delete(entry.handle)
    unregisterAcpConversation(this.session.slug, this.session.workspaceId, {
      handle: entry.handle,
      ...(entry.agentSessionId !== undefined ? { agentSessionId: entry.agentSessionId } : {}),
    })
    entry.conversation?.close()
    this.log(`[server] acp-driver ${this.session.workspaceId}/${entry.handle}: detached (${reason})`)
    // A drop can land between sweeps (e.g. a dial into a window whose acpd
    // is still binding), so re-evaluate the cadence now. The failure tally
    // keeps a broken window from forcing the fast cadence forever.
    this.attachFailures.set(entry.handle, (this.attachFailures.get(entry.handle) ?? 0) + 1)
    this.rearm()
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
    }))
    this.sink({ kind: 'live-agents', agents })
    // A newly attached conversation has had no turn boundary yet, so publish
    // its status. Skip unclassified ones (handshaking or recovering):
    // guessing `waiting` would mark a working agent as wanting attention.
    // They publish through `onBusy` once known.
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
  const dir = acpLogDir(session.slug, session.workspaceId)
  try {
    await fs.rename(path.join(dir, `${provisional}.jsonl`), path.join(dir, `${agentSessionId}.jsonl`))
  } catch (err) {
    // Only costs this conversation its history on the next attach.
    log(`[server] acp-driver ${session.workspaceId}: could not adopt log for ${agentSessionId}: ${String(err)}`)
  }
}

/** Poll the registry until the connection's sweep has attached `handle`. */
async function waitForConversation(
  slug: string,
  workspaceId: string,
  handle: string,
  timeoutMs: number,
): Promise<AcpConversation> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = acpConversationByHandle(slug, workspaceId, handle)
    if (found !== undefined) return found
    if (Date.now() >= deadline) {
      throw new Error(`no ACP conversation attached on ${handle} after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Park the model to send once the adapter handshakes, for adapters told
 * over the protocol (opencode, pi); a no-op for others.
 *
 * Parking is in-memory, and a spare can wait across server restarts, so a
 * spare claim parks it again; otherwise the adapter would run its default
 * (for pi, a provider whose key the proxy does not swap).
 */
export function parkAcpLaunchModel(tool: AgentTool, launchId: string, model: string | undefined): void {
  if (model !== undefined && acpModelIsProtocol(acpAdapterFor(tool))) stashAcpLaunchModel(launchId, model)
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
    const adapter = acpAdapterFor(spec.tool)
    // Park the model now, where the provider default is known; the
    // handshake delivers it.
    parkAcpLaunchModel(spec.tool, spec.agentSessionId, acpLaunchModel(spec))
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
   * conversation to attach, since session create runs before the sweep
   * has found the new window.
   */
  async deliverPrompt(session: DrivenWorkspace, handle: string, text: string): Promise<void> {
    const conversation = await waitForConversation(
      session.slug, session.workspaceId, handle, PROMPT_ATTACH_TIMEOUT_MS,
    )
    void conversation.prompt(text).catch((err: unknown) => {
      serverLog(`[server] acp-driver ${session.workspaceId}/${handle}: prompt failed: ${String(err)}`)
    })
  },
}
