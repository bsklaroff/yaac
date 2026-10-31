/**
 * The seam between yaac and how it drives a coding agent
 * (docs/agent-modes.md). A driver answers, independent of protocol:
 *
 *   - how to launch one (`launchCmd`)
 *   - what it is doing  (`connect`, which streams observations)
 *
 * One implementation per `AgentMode`: `tui-driver` watches the terminal UI
 * through tmux control mode, `acp-driver` speaks JSON-RPC to an agent under
 * acpd. Both run each agent in a tmux window of its own session and connect
 * over the workspace driver's `ctrl` stream, and both track the workspace's
 * windows through a tmux control-mode client. A workspace can hold sessions
 * of both modes, so its status watcher connects both, and each watches only
 * its own mode's sessions.
 *
 * Content is not part of this interface: PTY bytes and ACP events have
 * nothing in common, and the webapp picks a renderer per pane. Retry policy
 * is not either: a connection reports `down` and `WorkspaceStatusWatcher`
 * handles respawn for both modes.
 */

import { acpDriver } from './acp-driver'
import { tuiDriver } from './tui-driver'
import type { AgentMode, AgentStatus, AgentTool, PermissionMode } from '@yaac/shared/types'
import type { PiProvider } from '@yaac/shared/tool-providers'
import type { StreamChild, WorkspacePaths } from '#drivers/contract'

/** The workspace a driver is connected to. */
export interface DrivenWorkspace {
  projectId: string
  /** The workspace id, which streams are addressed by. */
  workspaceId: string
  jobName: string
}

/**
 * One open session of the workspace, as the drivers need it: which window
 * to watch, how, and what to tell its agent. Read from `#db` by the caller,
 * since only the rows know which windows are sessions and in which mode.
 */
export interface WatchedSession {
  /** Its tmux window, which is its handle. */
  window: string
  tool: AgentTool
  mode: AgentMode
  /** The conversation its agent holds, once named. `acp` re-addresses a
   *  live agent by it after a reconnect, or `session/load`s it after a
   *  restart. */
  conversationId?: string
  /** The id its window was launched under, which names a fresh `acp`
   *  record until its conversation is named (see `adoptLog`). */
  sessionId: string
  /**
   * Its permission posture, which `acp` sends to the adapter
   * (`session/set_mode`) and uses to decide who answers asks. Followed
   * afterwards through `setAcpPermissionMode`.
   */
  permissionMode: PermissionMode
  /** Its effort level, which `acp` puts a new or loaded conversation at
   *  (`session/set_config_option`). `tui` passes it at launch. */
  effort?: string
  /** The model it launched with, which `acp` tells an adapter that takes it
   *  no other way, once, after `session/new`. */
  model?: string
}

/**
 * One agent the driver sees running. `handle` is its address inside the
 * workspace and the status store's key: its session's window name, or for
 * an agent started by hand in a terminal, that pane's id (`%3`).
 */
export interface LiveAgent {
  handle: string
  tool: AgentTool
  /**
   * The conversation's id, once known: from `session/new` for `acp`, from
   * the pane's reporter (`PANE_SESSION_FORMAT`) for `tui`. codex and opencode
   * panes report nothing before their first turn.
   */
  conversationId?: string
  /** Its transcript, project-relative, when the pane named one (`tui`). */
  transcriptPath?: string
  /**
   * The model as the agent last reported it, pushed on change. `acp` gets it
   * from the adapter (handshake reply, `config_option_update`); `tui` from a
   * pane option set by the tool's reporter (`MODEL_PANE_OPTION`).
   */
  model?: string
  /** The agent's display name for `model` (`acp` only, from the adapter's
   *  model list). */
  modelName?: string
  /**
   * The permission mode as the agent last reported it, in its own terms: a
   * session mode id under `acp`, the reporter's value under `tui` (claude's
   * mode name, opencode's agent). `resolveAgentPermissionMode` maps it to a
   * posture. Absent until reported, which for some tools is never.
   */
  reportedMode?: string
  /**
   * The effort level as the agent last reported it, in the tool's words: the
   * adapter's effort option under `acp`, the reporter's value under `tui`
   * (`EFFORT_PANE_OPTION`). Absent until reported.
   */
  reportedEffort?: string
}

/**
 * What a connection reports upward: its health, the set of conversations,
 * and each one's busy/idle.
 */
export type AgentObservation =
  /** The connection is proven end to end and classifying. */
  | { kind: 'up' }
  /** It dropped. The caller respawns; status stays sticky. */
  | { kind: 'down'; reason: string }
  /** The agents running now, emitted after each listing of the windows. */
  | { kind: 'live-agents'; agents: LiveAgent[] }
  | { kind: 'status'; handle: string; status: AgentStatus }
  /**
   * A read-only command channel into the workspace, or null when it goes
   * away. Both drivers publish their control-mode client, which the status
   * watcher lists the workspace's windows over.
   */
  | { kind: 'command-channel'; send: ((cmd: string) => Promise<string>) | null }
  /** A tmux window was added, closed or renamed. */
  | { kind: 'windows-changed' }

export interface AgentConnection {
  close(): void
}

/** What a connection needs but may not fetch itself (the DB) or should not
 *  hard-code (timeouts, the dial). */
export interface AgentConnectDeps {
  /**
   * The workspace's open sessions, read on each listing of its windows. A
   * failed read leaves the connection watching what it had.
   */
  sessions?: () => Promise<WatchedSession[]>
  /** Test hook replacing the ctrl-stream dial, the process boundary both
   *  drivers are mocked at. */
  dial?: (session: DrivenWorkspace, argv: string[]) => StreamChild
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
   * The workspace's paths. A parameter because the launch command is built
   * before the workspace runs it, and so the command is a pure function of
   * the spec (which is how it is tested).
   */
  paths: WorkspacePaths
  /**
   * The conversation to create or resume. For `tui`, the id passed to the
   * tool's `--session-id`/resume flag. For `acp`, what its record is named
   * for; a new conversation's id comes from `session/new`, and its record is
   * renamed then.
   */
  conversationId: string
  resume: boolean
  /** The tmux window it runs in; for `acp` also its acpd socket name, hence
   *  its handle. */
  windowName: string
  model?: string
  /** Effort level, in the tool's words. See `AgentCmdSpec`. */
  effort?: string
  piProvider?: PiProvider
  /** The permission posture to launch in. See `AgentCmdSpec`. */
  permissionMode: PermissionMode
  /**
   * `acp` only: the launch runs before the checkout is complete, so the
   * conversation must not open until its `.git` lands (acpd's `--wait-for`).
   * The adapter boots meanwhile.
   */
  beforeCheckout?: boolean
}

/** The driver for a mode, chosen per session. */
export function agentDriver(mode: AgentMode): AgentDriver {
  return mode === 'acp' ? acpDriver : tuiDriver
}

export interface AgentDriver {
  readonly mode: AgentMode
  /**
   * The shell command that runs one conversation in its tmux window. It
   * `exec`s the program, since a /bin/sh like dash forks even a lone
   * command, and the pane's pid must be the agent's (acpd's under acp): an
   * ACP session counts only if the pane's current process minted it.
   */
  launchCmd(spec: AgentLaunchSpec): string
  /** Open the observation stream. Never throws; a failed dial is reported
   *  as `down` so the caller's backoff handles it. */
  connect(
    session: DrivenWorkspace,
    sink: (obs: AgentObservation) => void,
    deps?: AgentConnectDeps,
  ): AgentConnection
  /**
   * Deliver a user message to a live conversation, addressed by handle.
   * `tui` pastes it into the pane and submits; `acp` sends `session/prompt`.
   * `running` is for an agent already past its startup, in the conversation
   * named, whose user may be someone else: `tui` then pastes in the
   * foreground, refuses while the agent shows a dialog the text could answer
   * (`agentAtInputTest`), submits with one Enter, and rejects when nothing
   * was submitted.
   */
  deliverPrompt(
    session: DrivenWorkspace,
    handle: string,
    text: string,
    opts?: { running?: { tool: AgentTool; conversationId: string } },
  ): Promise<void>
}
