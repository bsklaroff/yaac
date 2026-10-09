import type {
  AgentMode,
  AgentTool,
  PermissionMode,
  WorkspaceDeathCause,
} from '@yaac/shared/types'

/**
 * Facts that substrate- and disk-observing code reports to db, applied by
 * `applyWorkspaceEvent` (docs/layered-server.md). Observers never write rows
 * themselves; they report a discrete, past-tense event and db decides which
 * rows change. This keeps observers simple, makes re-reporting after a
 * restart harmless, and puts the write-side invariants in one handler.
 *
 * Continuous state ("what is this agent doing now") is not an event; it
 * lives in the status store and the runtime report.
 */
export type WorkspaceEvent =
  | WorkspaceCreated
  | WorkspaceCreateFailed
  | WorkspaceLifeStarted
  | BaseBranchResolved
  | SessionsLaunched
  | SessionsDiscovered
  | SessionsCaptured
  | SessionsActive
  | PermissionModeChanged
  | EffortChanged
  | WorkspaceStopped

/**
 * Provisioning has begun. Emitted before anything is built, so every runtime
 * has a row.
 */
export interface WorkspaceCreated {
  type: 'workspace-created'
  projectId: string
  workspaceId: string
  /** The branch it forks from, resolved before provisioning. Absent on a
   *  resume, which keeps the recorded base. */
  baseBranch?: string
  /** An existing workspace is being restarted. Its row has history (title,
   *  founding prompt, how it last died), so a failed resume leaves the row
   *  as it was rather than erasing it. */
  resume?: boolean
  /** A prewarmed spare. It gets a row so a reap can tell it from a stopped
   *  workspace once its runtime is gone, but listings hide it until claimed. */
  spare?: boolean
  /** The permission mode its agents launch in, recorded so a restart reuses
   *  it rather than today's default. */
  permissionMode?: PermissionMode
  /** The first agent's model and agent mode, which a spare claim matches a
   *  request against (see `workspaces.model`). */
  model?: string
  mode?: AgentMode
  /** The effort its agents launch at, recorded so a restart reuses it. */
  effort?: string
  /** The zone it launches with as `TZ` (see `workspaces.timeZone`). */
  timeZone?: string
}

/**
 * Provisioning failed; undoes `workspace-created`. The handler decides what
 * that means: a fresh workspace's row is erased, a resumed one is left as
 * the restart found it.
 */
export interface WorkspaceCreateFailed {
  type: 'workspace-create-failed'
  projectId: string
  workspaceId: string
  resume?: boolean
}

/**
 * A new runtime life is starting for this workspace. Handling it clears every
 * recorded pane id in the same transaction, because tmux pane ids restart at
 * `%0` in a new runtime and an old handle would name the wrong pane. Emitted
 * after the row exists and before any handle is recorded.
 */
export interface WorkspaceLifeStarted {
  type: 'workspace-life-started'
  projectId: string
  workspaceId: string
}

/** A claimed spare was re-branched: the branch it now forks from. */
export interface BaseBranchResolved {
  type: 'base-branch-resolved'
  projectId: string
  workspaceId: string
  baseBranch: string
}

/**
 * The sessions a create started, in window order. Index 0 is the original
 * agent: a restart brings it up first, and its opening message is the
 * workspace's founding prompt.
 *
 * The list is complete and all live, so this one event records both which
 * sessions exist and which are running. Discovery reports these separately,
 * since a sweep also finds sessions that ended long ago.
 */
export interface SessionsLaunched {
  type: 'sessions-launched'
  projectId: string
  workspaceId: string
  sessions: LaunchedSession[]
}

export interface LaunchedSession {
  agentSessionId: string
  tool: AgentTool
  mode?: AgentMode
  /** The driver's handle for it, when known at launch. A `tui` pane id is
   *  not known until the pane exists. */
  paneId?: string
  /** The user's opening message, when they supplied one. */
  firstPrompt?: string
  /** The launch model, shown until the agent reports its own (see
   *  `agent_sessions.model`). */
  model?: string
}

/**
 * Sessions a discovery pass found in a workspace, each identified by its live
 * agent (a tui pane's reporter or an acp handshake). Only adds: the handler
 * fills in unknown fields and keeps known ones, so a compacted transcript
 * can't rewrite an opening message, and a conversation replaced by `/clear`
 * stays recorded.
 */
export interface SessionsDiscovered {
  type: 'sessions-discovered'
  projectId: string
  workspaceId: string
  sessions: DiscoveredSession[]
}

export interface DiscoveredSession {
  agentSessionId: string
  tool: AgentTool
  /** Recorded only on first sighting: a conversation can't change protocol,
   *  and a later wrong guess must not overwrite what the create reported. */
  mode?: AgentMode
  /** The driver's handle for it, when it is on one right now. */
  paneId?: string
  /** Its opening message, read out of the transcript or the ACP record. */
  firstPrompt?: string
  /** The transcript path relative to the project directory (never absolute),
   *  so it survives the data dir moving. Absent when the tool leaves no
   *  transcript or wrote one outside the project directory. */
  transcriptPath?: string
  lastActiveMs?: number
  /** The model the agent last reported. Overwrites (a `/model` changes it);
   *  absent leaves the row unchanged. */
  model?: string
  /** When the sweep first saw it, used as its birth if it is new. */
  firstSeenMs?: number
}

/**
 * What a stopped workspace's conversations left on disk, read once each
 * because no discovery pass recorded it before the stop. Fills only
 * conversations with no recorded last activity, and keeps a recorded first
 * message.
 */
export interface SessionsCaptured {
  type: 'sessions-captured'
  projectId: string
  workspaceId: string
  sessions: CapturedSession[]
}

export interface CapturedSession {
  agentSessionId: string
  tool: AgentTool
  /** Always set, so the conversation is not read again. */
  lastActiveMs: number
  firstPrompt?: string
}

/**
 * The complete set of a workspace's sessions running now; any linked session
 * not listed has stopped.
 *
 * No event is not an empty set. A watcher that can't see the agents sends
 * nothing, since a transient gap must not look like every agent exiting: the
 * last set is what a restart brings back up.
 */
export interface SessionsActive {
  type: 'sessions-active'
  projectId: string
  workspaceId: string
  active: ActiveSession[]
}

export interface ActiveSession {
  agentSessionId: string
  tool: AgentTool
  paneId?: string
}

/**
 * The running agent's permission mode changed, by the user or by the agent
 * itself (entering plan mode, a plan-exit answer). The row follows in either
 * direction: a restart relaunches in it, and `yaac-mama create` caps a
 * sibling at it.
 */
export interface PermissionModeChanged {
  type: 'permission-mode-changed'
  projectId: string
  workspaceId: string
  permissionMode: PermissionMode
}

/**
 * The running agent's effort level changed (`/effort`, a model switch that
 * re-seeds it, the chat pane's menu). The row follows, so a restart
 * relaunches at it (docs/effort-levels.md).
 */
export interface EffortChanged {
  type: 'effort-changed'
  projectId: string
  workspaceId: string
  effort: string
}


/**
 * A workspace's runtime went away (user stop, project teardown, or reaper).
 * `cause` is set only by a reaper, so a plain stop can't inherit an earlier
 * death's reason.
 */
export interface WorkspaceStopped {
  type: 'workspace-stopped'
  projectId: string
  workspaceId: string
  cause?: WorkspaceDeathCause
}
