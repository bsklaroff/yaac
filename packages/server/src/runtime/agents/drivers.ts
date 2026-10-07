/**
 * The seam between yaac and how it drives a coding agent
 * (docs/agent-modes.md). A driver answers, independent of protocol:
 *
 *   - how to launch one (`launchCmd`)
 *   - what it is doing  (`connect`, which streams observations)
 *
 * One implementation per `AgentMode`: `tui-driver` watches the terminal UI
 * through tmux control mode, `acp-driver` speaks JSON-RPC to an agent under
 * acpd. Both run the agent in a tmux window and connect over the workspace
 * driver's `ctrl` stream, and both track the workspace's windows through a
 * tmux control-mode client.
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

/** The session a driver is connected to. */
export interface DrivenWorkspace {
  projectId: string
  /** The workspace id, which streams are addressed by. */
  workspaceId: string
  jobName: string
  tool: AgentTool
}

/**
 * One conversation the driver sees running. `handle` is its address inside
 * the workspace and the status store's key: a tmux pane id (`%3`) for `tui`,
 * the window/acpd socket name (`claude`, `claude-2`) for `acp`.
 */
export interface LiveAgent {
  handle: string
  tool: AgentTool
  /**
   * The conversation's id, once known: from `session/new` for `acp`, from
   * the pane's reporter (`PANE_SESSION_FORMAT`) for `tui`. codex and opencode
   * panes report nothing before their first turn.
   */
  agentSessionId?: string
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
  /** The conversations running now. Never emitted empty before the agent
   *  starts, since an empty set means "every agent exited" and deactivates
   *  the workspace's conversations. */
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
   * The workspace's recorded conversations, by handle. `acp` needs them to
   * re-address a live agent after a reconnect (or `session/load` after a
   * restart); the agent mints the id and only the DB remembers it.
   */
  recordedSessions?: () => Promise<Array<{ handle: string; agentSessionId: string }>>
  /**
   * The workspace's permission posture, read once at connect and then
   * followed through `setAcpPermissionMode`. `acp` sends it to the adapter
   * (`session/set_mode`) and uses it to decide who answers asks; a
   * connection is rebuilt apart from the launch, so it cannot come from
   * `AgentLaunchSpec`.
   *
   * `undefined` means unknown (no row, failed read) and is not `bypass`:
   * asks are forwarded, since a needless prompt is recoverable and a
   * needless approval is not. Omitting the accessor gives `bypass`.
   */
  permissionMode?: () => Promise<PermissionMode | undefined>
  /**
   * The model the workspace launched `tool` with, as `acp` tells it over the
   * protocol. Read only when a fresh conversation finds no model parked,
   * since a server restart between launch and handshake loses the park.
   */
  launchModel?: (tool: AgentTool) => Promise<string | undefined>
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
   * tool's `--session-id`/resume flag. For `acp`, used only on resume; a new
   * conversation's id comes from `session/new`.
   */
  agentSessionId: string
  resume: boolean
  /** The tmux window it runs in; for `acp` also its acpd socket name, hence
   *  its handle. */
  windowName: string
  model?: string
  piProvider?: PiProvider
  /** The permission posture to launch in. See `AgentCmdSpec`. */
  permissionMode: PermissionMode
}

/**
 * The driver for a mode. The only place the two are chosen between, so the
 * mode does not leak into session create, the status watcher or the
 * registry.
 */
export function agentDriver(mode: AgentMode): AgentDriver {
  return mode === 'acp' ? acpDriver : tuiDriver
}

export interface AgentDriver {
  readonly mode: AgentMode
  /** The shell command that runs one conversation in its tmux window. */
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
    opts?: { running?: { agentSessionId: string } },
  ): Promise<void>
}
