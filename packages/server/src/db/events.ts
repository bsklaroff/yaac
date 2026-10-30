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
  | TrackedScratchDirsFound
  | ConversationsDiscovered
  | ConversationsCaptured
  | ConversationsActive
  | SessionReported
  | WaitingEnded
  | WorkspaceStopped
  | IgnoredFilesCleaned

/**
 * Provisioning has begun, emitted before anything is built so every user
 * workspace's runtime has a row; or a prewarmed spare was claimed, which is
 * the claim's commit point (a spare has no row until then).
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
  /** The user's title, the title generated for the draft or queued entry it
   *  was created from, and its sidebar group, on a fresh create. */
  title?: string
  generatedTitle?: string
  groupId?: string
  /** The zone it launches with as `TZ` (see `workspaces.timeZone`). */
  timeZone?: string
  /** When the server stops it (see `workspaces.deadline`). A resume without
   *  one clears the deadline. */
  deadline?: Date
  /** The scratch dirs it is started with (see `workspaces.scratchDirs`). */
  scratchDirs?: string[]
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
 * A new runtime life is starting for this workspace, so none of its sessions
 * has a window in it yet. Emitted after the row exists and before any
 * session is launched.
 */
export interface WorkspaceLifeStarted {
  type: 'workspace-life-started'
  projectId: string
  workspaceId: string
}

/** The branch a workspace forks from changed: its agent ran
 *  `yaac-mama set-base`. */
export interface BaseBranchResolved {
  type: 'base-branch-resolved'
  projectId: string
  workspaceId: string
  baseBranch: string
}

/** Which of its scratch dirs git tracks, read from the main clone as a
 *  workspace starts. Replaces what the last start found. */
export interface TrackedScratchDirsFound {
  type: 'tracked-scratch-dirs-found'
  projectId: string
  workspaceId: string
  paths: string[]
}

/**
 * Conversations a discovery pass found in a workspace, each named by its live
 * agent (a tui pane's reporter or an acp handshake). Only adds: the handler
 * fills in unknown fields and keeps known ones, so a compacted transcript
 * can't rewrite an opening message, and a conversation replaced by `/clear`
 * stays recorded.
 */
export interface ConversationsDiscovered {
  type: 'conversations-discovered'
  projectId: string
  workspaceId: string
  sessions: DiscoveredConversation[]
}

export interface DiscoveredConversation {
  conversationId: string
  tool: AgentTool
  /** Recorded only on first sighting: a conversation can't change protocol,
   *  and a later wrong guess must not overwrite what the create reported. */
  mode?: AgentMode
  /** The session whose agent holds it; absent for an agent started by hand
   *  in a terminal. */
  sessionId?: string
  /** Its opening message, read out of the transcript or the ACP record. */
  firstPrompt?: string
  /** The title the agent gave it. Overwrites (the agent or a rename inside
   *  the tool can change it); absent leaves the row unchanged. */
  title?: string
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
export interface ConversationsCaptured {
  type: 'conversations-captured'
  projectId: string
  workspaceId: string
  sessions: CapturedConversation[]
}

export interface CapturedConversation {
  conversationId: string
  tool: AgentTool
  /** Always set, so the conversation is not read again. */
  lastActiveMs: number
  firstPrompt?: string
}

/**
 * The complete set of a workspace's conversations live now; any linked one
 * not listed has stopped.
 *
 * No event is not an empty set. A watcher that can't see the agents sends
 * nothing, since a transient gap must not look like every agent exiting: the
 * last set is what a restart brings back up.
 */
export interface ConversationsActive {
  type: 'conversations-active'
  projectId: string
  workspaceId: string
  active: ActiveConversation[]
}

export interface ActiveConversation {
  conversationId: string
  tool: AgentTool
}

/**
 * A session's agent reported a change: the conversation it holds (a
 * `/clear`), its model, its permission mode (Shift+Tab, entering plan mode, a
 * plan-exit answer) or its effort (docs/effort-levels.md). The row follows,
 * so a restart relaunches the same way and `yaac-mama` caps by the posture
 * the agent is really in. Only the fields that changed are set.
 */
export interface SessionReported {
  type: 'session-reported'
  projectId: string
  workspaceId: string
  sessionId: string
  conversationId?: string
  model?: string
  permissionMode?: PermissionMode
  effort?: string
}

/**
 * The agent in a session's window stopped needing the user: it went back to
 * work, including one found mid-turn after a server restart. The spell it
 * waits in next is new to every user, so its `waitingSeenBy` empties.
 */
export interface WaitingEnded {
  type: 'waiting-ended'
  projectId: string
  workspaceId: string
  /** The session's window, which is the status store's handle. */
  window: string
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

/**
 * A removal of a stopped workspace's gitignored files that began at `at`
 * finished. It counts only for a stop recorded by then, so a clean that
 * outlived a restart does not answer for the next stop.
 */
export interface IgnoredFilesCleaned {
  type: 'ignored-files-cleaned'
  projectId: string
  workspaceId: string
  at: Date
}
