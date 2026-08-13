/**
 * The seam between yaac and *how* it drives a coding agent.
 *
 * A driver answers the two questions the rest of the server asks about an
 * agent, in a form that does not depend on which protocol it speaks:
 *
 *   - how do I launch one? (`launchCmd`)
 *   - what is it doing?    (`connect`, which streams observations)
 *
 * Two implementations, one per `AgentMode`: `tui-driver` watches an agent's
 * terminal UI through tmux control mode, and `acp-driver` talks JSON-RPC to an
 * agent under acpd. Both launch into a tmux window and both ride a streamd
 * `ctrl` stream — tmux is the process supervisor either way, and only the
 * presentation transport differs.
 *
 * What is deliberately NOT in this interface is content. PTY bytes and ACP
 * message events have nothing in common, and forcing them into one union
 * would produce a protocol neither side can implement honestly. The webapp
 * already models that split (a pane target picks its renderer), so the
 * abstraction stops at lifecycle and status — the part that is genuinely
 * shared — and content stays mode-specific by design.
 *
 * Retry policy is not here either. A connection reports that it went down and
 * the caller decides what to do about it, so both modes get one respawn
 * strategy (`WorktreeStatusWatcher`) rather than two that drift.
 */

import { acpDriver } from './acp-driver'
import { tuiDriver } from './tui-driver'
import type { AgentMode, AgentTool } from '@yaac/shared/types'
import type { PiProvider } from '@yaac/shared/tool-providers'
import type { StreamChild } from '#drivers/contract'
import type { AgentPaneStatus } from './agent-tools'

/** The session a driver is connected to. */
export interface DrivenWorktree {
  slug: string
  /** The worktree id — what the relay addresses streams by. */
  worktreeId: string
  jobName: string
  tool: AgentTool
}

/**
 * One conversation a driver can see running right now.
 *
 * `handle` is the driver's address for it *inside the pod*, and it is what
 * the status store keys statuses by: a tmux pane id (`%3`) for `tui`, the
 * acpd socket's window name (`claude`, `claude-2`) for `acp`. Both are
 * per-conversation addresses that outlive a single observation, which is all
 * the store needs them to be.
 */
export interface LiveAgent {
  handle: string
  tool: AgentTool
  /**
   * The conversation's own id, when the driver knows it. `acp` always does —
   * it created the session and holds the id. `tui` never does: which
   * conversation a pane has loaded is the in-pod hook's session-starts log to
   * answer, and the registry joins the two.
   */
  agentSessionId?: string
}

/**
 * What a connection reports upward. This is the whole common protocol: a
 * connection's health, the set of conversations, and each one's busy/idle.
 */
export type AgentObservation =
  /** The connection is proven end to end and classifying. */
  | { kind: 'up' }
  /** It dropped. The caller respawns; status stays sticky. */
  | { kind: 'down'; reason: string }
  /** The conversations running right now. Never emitted empty for a session
   *  that simply has not started its agent yet — an empty set means "every
   *  agent exited", which deactivates the worktree's conversations. */
  | { kind: 'live-agents'; agents: LiveAgent[] }
  | { kind: 'status'; handle: string; status: AgentPaneStatus }
  /**
   * A read-only command channel into the pod, or null when it goes away.
   * `tui` publishes its tmux control-mode client here so unrelated read-only
   * tmux queries (the webapp's terminal listing) ride the open stream instead
   * of dialing their own; `acp` has no such channel and never emits this.
   *
   * It travels as an observation rather than the driver registering it
   * directly because the registry lives in `#runtime/status`, which already
   * imports this feature — publishing it upward is what keeps the dependency
   * one-directional.
   */
  | { kind: 'command-channel'; send: ((cmd: string) => Promise<string>) | null }

export interface AgentConnection {
  close(): void
}

/** Everything a connection needs that this feature is not allowed to reach
 *  for itself (the DB) or should not hard-code (timeouts, the dial). */
export interface AgentConnectDeps {
  /**
   * The conversations yaac has already recorded for this worktree, keyed by
   * handle. `acp` needs them to re-address a live agent after a reconnect
   * (and to `session/load` after a restart) — the ACP session id is the
   * agent's to mint, and only the database remembers it across a server
   * restart. Supplied by the caller because the agents feature has no
   * database access, which is exactly what keeps it sealed.
   */
  recordedSessions?: () => Promise<Array<{ handle: string; agentSessionId: string }>>
  /** Injected by tests — replaces the real relay ctrl-stream dial, which is
   *  the process boundary both drivers are mocked at. */
  dial?: (session: DrivenWorktree, argv: string[]) => StreamChild
  /** Heartbeat cadence over the open connection. */
  heartbeatIntervalMs?: number
  /** Reply deadline for a command sent over the connection. */
  commandTimeoutMs?: number
  log?: (msg: string) => void
}

/** What a driver needs to build one conversation's launch command. */
export interface AgentLaunchSpec {
  tool: AgentTool
  /**
   * The conversation to create or resume. For `tui` this is the id passed to
   * the tool's own `--session-id`/`resume` flag. For `acp` it is only used on
   * a resume — a fresh ACP conversation's id comes back from `session/new`,
   * so the agent, not yaac, chooses it.
   */
  agentSessionId: string
  resume: boolean
  /** The tmux window it runs in. For `acp` this also names its acpd socket,
   *  which is why it is the conversation's handle. */
  windowName: string
  model?: string
  piProvider?: PiProvider
}

/**
 * The driver for a mode. The one place the two implementations are chosen
 * between — every caller downstream holds an `AgentDriver` and never a
 * mode-specific type, which is what keeps the mode from leaking into session
 * create, the status watcher, or the registry.
 */
export function agentDriver(mode: AgentMode): AgentDriver {
  return mode === 'acp' ? acpDriver : tuiDriver
}

export interface AgentDriver {
  readonly mode: AgentMode
  /** The shell command that runs one conversation in its tmux window. */
  launchCmd(spec: AgentLaunchSpec): string
  /** Open the observation stream. Never throws — a failed dial is reported
   *  as a `down` observation so the caller's backoff owns it. */
  connect(
    session: DrivenWorktree,
    sink: (obs: AgentObservation) => void,
    deps?: AgentConnectDeps,
  ): AgentConnection
  /**
   * Deliver a user message to a live conversation, addressed by handle.
   * `tui` pastes it into the pane and submits; `acp` sends `session/prompt`.
   */
  deliverPrompt(session: DrivenWorktree, handle: string, text: string): Promise<void>
}
