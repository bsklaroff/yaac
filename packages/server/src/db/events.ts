import type {
  AgentMode,
  AgentTool,
  WorktreeDeathCause,
} from '@yaac/shared/types'

/**
 * What substrate- and disk-observing code tells db it found — the ONE
 * door through which observed facts become rows (`applyWorktreeEvent`).
 *
 * Code that watches the substrate or reads a worktree's disk never writes a
 * row: it reports a discrete, past-tense event, and which table that lands
 * in is decided here alone. That inversion is what keeps every observer
 * mechanical, makes re-reporting after a restart a no-op rather than a
 * clobber, and lets one handler own the write-side invariants below
 * (docs/layered-server.md).
 *
 * A `WorktreeEvent` is discrete and past-tense — something that happened,
 * applied once to a row. That is what separates it from the status store,
 * which answers the continuous "what is this agent doing right now" and is
 * carried in the runtime report rather than here.
 */
export type WorktreeEvent =
  | WorktreeCreated
  | WorktreeCreateFailed
  | WorktreeLifeStarted
  | BaseBranchResolved
  | SessionsLaunched
  | SessionsDiscovered
  | SessionsActive
  | WorktreeStopped

/**
 * Provisioning has begun for a worktree — emitted before anything is built,
 * so no runtime can ever exist that the server has no row for.
 */
export interface WorktreeCreated {
  type: 'worktree-created'
  projectSlug: string
  worktreeId: string
  /** Set only when the branch is known this early, as it is for a claimed
   *  prewarmed spare. A cold create resolves it while the pod boots and
   *  reports it separately, so recording the worktree never waits on the
   *  checkout. */
  baseBranch?: string
  /** This worktree already existed and is being brought back up. Its row
   *  carries a history — title, pin, founding prompt, and how it last died —
   *  which is why a failed resume is put back rather than erased. */
  resume?: boolean
  /** This is a prewarmed spare being warmed, not a worktree being created.
   *  It gets a row so a reap can still tell it from a stopped worktree once
   *  its pod is gone, but every listing filters it out until it is claimed. */
  spare?: boolean
  /** Whether this worktree's agents launch with their auto-approve flags.
   *  Recorded with the row because a restart has to relaunch them the way
   *  the user asked rather than re-deriving today's default. */
  autoApprove?: boolean
}

/**
 * Provisioning gave up. The counterpart to `worktree-created`, and the reason
 * that event can be sent before anything is built: whatever it started, this
 * undoes.
 *
 * What "undo" means is decided by the handler alone, and it differs by
 * `resume` — a fresh worktree is erased, a resumed one is put back exactly as
 * the restart found it. The emitter knows only that it failed.
 */
export interface WorktreeCreateFailed {
  type: 'worktree-create-failed'
  projectSlug: string
  worktreeId: string
  resume?: boolean
}

/**
 * A pod has come up for this worktree — a **life** has begun.
 *
 * The event that invalidates the previous life's handles. Handling it NULLs
 * every recorded pane id in the same transaction that stamps the life,
 * because tmux pane ids restart at `%0` in a new pod and a surviving handle
 * would name a pane this life owns.
 *
 * Emitted after the worktree is recorded and before the Job exists, so the
 * first thing the in-pod hook can append is already on the right side of the
 * boundary below.
 */
export interface WorktreeLifeStarted {
  type: 'worktree-life-started'
  projectSlug: string
  worktreeId: string
  /** The session-starts log's length right now. Nothing this life wrote is
   *  in it yet, so everything already there belongs to a previous pod — which
   *  is what the discovery fold reads it back to decide. */
  logBytes: number
}

/** The branch a worktree forked from, resolved by the checkout. */
export interface BaseBranchResolved {
  type: 'base-branch-resolved'
  projectSlug: string
  worktreeId: string
  baseBranch: string
}

/**
 * The sessions a create started, in the order their windows were laid
 * out — index 0 is the worktree's original agent, the one a restart brings up
 * first and whose opening message becomes the worktree's founding ask.
 *
 * The list is complete and every entry is live, which is what lets one event
 * carry both halves of the record: which sessions this worktree has, and
 * which of them are running. Discovery reports the two separately, because a
 * sweep finds sessions that ended long ago.
 */
export interface SessionsLaunched {
  type: 'sessions-launched'
  projectSlug: string
  worktreeId: string
  sessions: LaunchedSession[]
}

export interface LaunchedSession {
  agentSessionId: string
  tool: AgentTool
  /** Absent where the create cannot know it: a `tui` conversation's handle is
   *  a tmux pane id, which does not exist until the pane does. */
  mode?: AgentMode
  /** The driver's handle for it inside the pod, when knowable at launch. */
  paneId?: string
  /** The user's opening message, when they supplied one. */
  firstPrompt?: string
}

/**
 * The sessions a sweep found in a worktree — its whole history, since a
 * session the sweep can still see is one the worktree has hosted. Only
 * ever adds: the handler fills in what it did not know and keeps what it
 * did, so a sweep that reads a compacted transcript cannot rewrite an
 * opening message.
 *
 * Where the history comes from is the one thing that differs by mode. Under
 * `tui` the sweep folds whatever the in-pod hook has appended to the
 * worktree's session-starts log; under `acp` there is nothing to discover,
 * because the server is the ACP client and the handshake handed it the id.
 */
export interface SessionsDiscovered {
  type: 'sessions-discovered'
  projectSlug: string
  worktreeId: string
  sessions: DiscoveredSession[]
}

export interface DiscoveredSession {
  agentSessionId: string
  tool: AgentTool
  /** Only ever recorded on first sighting: a conversation cannot change
   *  protocol mid-life, and a later sighting that guessed wrong must not
   *  rewrite what the create path reported. */
  mode?: AgentMode
  /** The driver's handle for it, when it is on one right now. */
  paneId?: string
  /** Its opening message, read out of the transcript or the ACP record. */
  firstPrompt?: string
  /** The transcript, **relative to the project directory** — never absolute.
   *  Project-relative means the same thing wherever the data dir sits and
   *  survives it moving. Absent when the tool leaves no transcript, or
   *  wrote one outside the project directory. */
  transcriptPath?: string
  lastActiveMs?: number
  /** When the sweep first saw it, used as its birth if it is new. */
  firstSeenMs?: number
}

/**
 * Which of a worktree's sessions are running right now — the complete
 * live set, so anything linked and unnamed here has stopped.
 *
 * Absence of this event is emphatically NOT an empty set. A watcher that
 * cannot see a worktree's agents says nothing, because blanking the set on
 * a transient gap would look like "every agent exited" — and the frozen set
 * is exactly what a restart brings back up.
 */
export interface SessionsActive {
  type: 'sessions-active'
  projectSlug: string
  worktreeId: string
  active: ActiveSession[]
}

export interface ActiveSession {
  agentSessionId: string
  tool: AgentTool
  paneId?: string
}

/**
 * A worktree's runtime went away — a user stop, a project teardown, or a
 * reaper. `cause` is set only when a reaper (not the user) tore it down, so a
 * plain stop cannot inherit an earlier death's reason.
 */
export interface WorktreeStopped {
  type: 'worktree-stopped'
  projectSlug: string
  worktreeId: string
  cause?: WorktreeDeathCause
}

export { MAX_PROMPT_LENGTH } from '@yaac/shared/types'
