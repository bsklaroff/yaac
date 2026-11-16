import type { VolumeLease } from './volume-store'
import type {
  AgentMode,
  AgentTool,
  PermissionMode,
  WorkspaceDeathCause,
} from '@yaac/shared/types'
import type { StepState, StepsOutcome } from '@yaac/shared/steps'
import type { LifeWorkflow } from './step-store'
import type { LifeLaunch } from './workspace-store'
import type { CheckpointOutcome } from './schema'

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
  | WorkspaceLaunched
  | BaseBranchResolved
  | StartCommitResolved
  | StepChanged
  | StepsSettled
  | TrackedScratchDirsFound
  | ConversationsDiscovered
  | ConversationsCaptured
  | ConversationsActive
  | SessionReported
  | SessionWindowGone
  | WaitingEnded
  | WorkspaceStopped
  | IgnoredFilesCleaned
  | LifeNodeFound
  | LifeCheckpointed
  | VolumeReleased
  | VolumesPinned

/** A life as it starts: what it launches with, the workflows it starts, and
 *  the init workflows it skips for lack of a repo they name. */
export interface LifeStart extends LifeLaunch {
  startSteps: LifeWorkflow[]
  skipped?: Array<{ id: string; name: string }>
}

/**
 * Provisioning of a new workspace has begun, emitted before anything is
 * built so every user workspace's runtime has a row; or a prewarmed spare
 * was claimed, which is the claim's commit point (a spare has no row until
 * then). Its first life starts with it, now unless `at` says when, so none
 * of its sessions has a window yet.
 */
export interface WorkspaceCreated extends Partial<LifeStart> {
  type: 'workspace-created'
  projectId: string
  workspaceId: string
  /** Its checkouts, each with the branch it forks from when that is
   *  resolved before provisioning, and where its shells and steps start. */
  repos?: Array<{ repoId: string; path: string; baseBranch?: string }>
  cwd?: string
  /** The user's title, the title generated for the draft or queued entry it
   *  was created from, and its sidebar group. */
  title?: string
  generatedTitle?: string
  groupId?: string
  /** The graph it brought in place of the project's init steps, whether it
   *  is non-interactive, and the non-interactive workspace it reruns. */
  workflowId?: string
  /** The named workflow it was chosen through: a record. */
  workflowName?: string
  nonInteractive?: boolean
  rerunOf?: string
  /** The public site it is a release of. */
  siteId?: string
}

/**
 * Provisioning failed; undoes what the create recorded. A fresh workspace's
 * row is erased. A restart's workspace has history (title, founding prompt,
 * how it last died), so it loses only the life the restart had started, if
 * it got that far, and reads as the restart found it.
 */
export interface WorkspaceCreateFailed {
  type: 'workspace-create-failed'
  projectId: string
  workspaceId: string
  /** On a failed restart: when the life it restarted from began. */
  lifeBefore?: Date
}

/**
 * A workspace is restarting: its next life starts, so none of its sessions
 * has a window in it yet. Emitted before any session is launched.
 */
export interface WorkspaceLifeStarted extends LifeStart {
  type: 'workspace-life-started'
  projectId: string
  workspaceId: string
}

/**
 * The runtime of a workspace's current life came up: its create, claim or
 * restart finished. A current life without this, whose runtime is gone and
 * which no create in this process is starting, never came up.
 */
export interface WorkspaceLaunched {
  type: 'workspace-launched'
  projectId: string
  workspaceId: string
}

/** The commit one of a workspace's checkouts was created at. */
export interface StartCommitResolved {
  type: 'start-commit-resolved'
  projectId: string
  workspaceId: string
  repoId: string
  startCommit: string
}

/**
 * A step's window was opened, became ready, exited or was killed, or the
 * step was skipped because a step it needs did not succeed. Applies only to
 * the life it was observed in.
 */
export interface StepChanged {
  type: 'step-changed'
  projectId: string
  workspaceId: string
  life: Date
  /** The step's workflow's name in the workspace, and its own. */
  workflowName: string
  name: string
  state: StepState
  exitCode?: number
}

/** A non-interactive workspace's graph settled. */
export interface StepsSettled {
  type: 'steps-settled'
  projectId: string
  workspaceId: string
  outcome: StepsOutcome
}

/** The branch one of a workspace's checkouts forks from changed: its agent
 *  ran `yaac-mama set-base`, or a restart rebuilt a lost checkout from the
 *  default branch because origin no longer has the old one. */
export interface BaseBranchResolved {
  type: 'base-branch-resolved'
  projectId: string
  workspaceId: string
  repoId: string
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
 * A session's window, seen earlier in this life, is gone from the
 * workspace's listing: the user killed it in tmux. The session closes, so
 * nothing relaunches it.
 */
export interface SessionWindowGone {
  type: 'session-window-gone'
  projectId: string
  workspaceId: string
  sessionId: string
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
 * A workspace's runtime went away (user stop, project teardown, or reaper),
 * which ends its current life. `cause` is set only by a reaper.
 */
export interface WorkspaceStopped {
  type: 'workspace-stopped'
  projectId: string
  workspaceId: string
  cause?: WorkspaceDeathCause
}

/** The current life's pod is running on `node`, where its tree is. */
export interface LifeNodeFound {
  type: 'life-node-found'
  projectId: string
  workspaceId: string
  node: string
}

/**
 * The node-local life that began at `life` has its tree saved, or found
 * nothing to save, or lost it with its node
 * (docs/node-local-workspaces.md "Life cycle"). Restart and delete
 * wait for this.
 */
export interface LifeCheckpointed {
  type: 'life-checkpointed'
  projectId: string
  workspaceId: string
  life: Date
  outcome: CheckpointOutcome
  /** For a lost life: when its last checkpoint was taken. */
  detail?: string
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

/**
 * A volume's holder was confirmed gone (no unit, not merely stopping), so
 * that lease ends, unless it was renewed since it was read
 * (docs/workspace-volumes.md).
 */
export interface VolumeReleased {
  type: 'volume-released'
  volumeId: string
  lease: VolumeLease
}

/** These volumes' first disks were bound and kept, so losing one later is
 *  an error rather than a fresh start. */
export interface VolumesPinned {
  type: 'volumes-pinned'
  volumeIds: string[]
}
