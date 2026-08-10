import type {
  AgentMode,
  AgentTool,
  GitAuthFailure,
  PortMapping,
  WorktreeDeathCause,
  StaleWorktreeInfo,
} from '#types'

/**
 * What a herd says its workspaces are doing right now.
 *
 * A whole snapshot, never a delta: a herd holds no state, so it can always
 * recompute one, and the server never has to reconcile a partial stream
 * against a restart.
 *
 * Everything here is runtime — what the substrate can see this instant, and
 * nothing that survives it. The durable half of a listing (a title, a pin,
 * the recorded creation time, the sessions and their opening messages)
 * is the server's, and joining the two is what produces a session list.
 */
export interface HerdReport {
  workspaces: WorkspaceReport[]
  /** Recorded workspaces whose runtime is gone, for the caller to tear down. */
  stale: StaleWorktreeInfo[]
  /** Project slug → git credentials the upstream rejected. Project-wide and
   *  independent of the workspace set: a bad token persists with nothing
   *  running and blocks new work. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface WorkspaceReport {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /** `terminating` is on its way out — a non-interactive placeholder, not a
   *  live workspace. Its agents are already evicted, so it reports none. */
  phase: 'running' | 'terminating'
  /** When the runtime came up. The server prefers its own recorded time,
   *  which survives a restart; this is the fallback for a workspace it has
   *  no row for. */
  createdAtMs: number
  /** The workspace's aggregate over every live agent: `waiting` if any is. */
  status: 'running' | 'waiting'
  waitingSinceMs?: number
  /** Per-agent liveness, keyed by the driver's handle — a tmux pane id under
   *  `tui`, the acpd window name under `acp`. The server joins its
   *  sessions onto these by the handle each was last seen on; a handle
   *  with no conversation is one whose id has not landed yet. */
  agents: AgentLiveness[]
  blockedHosts: string[]
  forwardedPorts: PortMapping[]
  unforwardedPorts: number[]
}

/**
 * Cap on a reported opening message, applied by whoever stores it. Generous
 * next to a title — the sidebar truncates for display, but the prompt also
 * feeds title generation, which reads the opening ~1000 chars.
 *
 * Here rather than beside the table because it bounds what crosses the
 * boundary: a herd caches what it read at this length, so the copy it
 * re-reports and the copy the server keeps cannot disagree.
 */
export const MAX_PROMPT_LENGTH = 4000

/**
 * A workspace as the substrate can see it — everything a resolver needs and
 * nothing the server records. The durable half (a title, a pin, the recorded
 * creation time, the conversations) never appears here; joining the two is
 * the server's job.
 *
 * Distinct from `WorkspaceReport`, which is what a whole-herd report carries:
 * this is the answer to "which workspace does this id name", so it names the
 * runtime handle an exec addresses and says nothing about liveness.
 */
export interface WorkspaceHandle {
  workspaceId: string
  projectSlug: string
  /** The runtime's own name for it, which is what an exec addresses. */
  jobName: string
  tool: AgentTool
  running: boolean
  /** Lowercased runtime phase — `running`, `pending`, `failed`, … */
  state: string
  labels: Record<string, string>
  createdAtMs: number
  /** A warmed spare, not a user's workspace. */
  prewarmed: boolean
}

export interface AgentLiveness {
  handle: string
  status: 'running' | 'waiting'
  waitingSinceMs?: number
}

/**
 * What the server says should exist — the only thing a herd is TOLD rather
 * than asked, and the only level-triggered state in the contract.
 *
 * The stale reaper needs it because absence is meaningless without it: a
 * runtime nothing recorded is a leak, a record with no runtime is a create
 * that died, and the substrate cannot tell one from the other.
 */
export interface DesiredWorkspaces {
  live: DesiredWorkspace[]
  /** `<projectSlug>/<worktreeId>` of workspaces already recorded as stopped —
   *  what tells a teardown yaac issued from one that happened to it. */
  stopped: string[]
  /**
   * Workspaces the server is still provisioning, and therefore owns end to
   * end. Every sweep exempts one regardless of age: a create's Job may not
   * be applied yet, so no listing can vouch for it, and reaping mid-create
   * deletes the staged session dir out from under the starting pod.
   *
   * Only ones still in flight. A create that has already FAILED is not still
   * running — its row lingers until the user dismisses it and its own
   * rollback has torn down whatever it left — so it must shield nothing.
   *
   * Delivered rather than looked up: the in-flight set is a server registry
   * (it drives a sidebar row), and a herd never reads one.
   */
  provisioning: string[]
}

export interface DesiredWorkspace {
  projectSlug: string
  worktreeId: string
  /** Whether its agent ever got going. Separates an interrupted create from a
   *  workspace with real history whose runtime was removed out from under it,
   *  which is the difference between `never-started` and `orphaned`. */
  ran: boolean
}

/**
 * What a herd tells the server it found.
 *
 * A herd owns bulk bytes and live runtime state — the cluster, the worktrees,
 * the transcripts and ACP records, the tmux sessions — and the server owns
 * every durable fact a client can ask about. So the two halves meet twice:
 * data the herd needs is *delivered* to it, and facts the herd discovers are
 * *reported* here for the server to persist. It never looks a row up itself
 * (docs/plans/layered-server.md).
 *
 * A `HerdEvent` is discrete and past-tense — something that happened, applied
 * once to a row. That is what separates it from `#features/status`, which
 * answers the continuous "what is this agent doing right now" and is carried
 * in the periodic report rather than here.
 *
 * The union grows one variant per severed call site, so its membership is a
 * statement about which discoveries have already stopped writing rows
 * directly. Still to come: sessions found by the registry sweep, and
 * first prompts read out of transcripts and ACP records.
 */
export type HerdEvent =
  | WorktreeCreated
  | WorktreeCreateFailed
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
}

/**
 * Provisioning gave up. The counterpart to `worktree-created`, and the reason
 * that event can be sent before anything is built: whatever it started, this
 * undoes.
 *
 * What "undo" means is the server's alone to decide, and it differs by
 * `resume` — a fresh worktree is erased, a resumed one is put back exactly as
 * the restart found it. A herd knows only that it failed.
 */
export interface WorktreeCreateFailed {
  type: 'worktree-create-failed'
  projectSlug: string
  worktreeId: string
  resume?: boolean
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
 * session the herd can still see is one the worktree has hosted. Only
 * ever adds: the server fills in what it did not know and keeps what it did,
 * so a sweep that reads a compacted transcript cannot rewrite an opening
 * message.
 *
 * Where the history comes from is the one thing that differs by mode. Under
 * `tui` it is the worktree's metadata document, into which the herd folds
 * whatever the in-pod hook has appended to its session-starts log; under
 * `acp` there is nothing to discover, because the server is the ACP client
 * and the handshake handed it the id.
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
   *  An absolute path names a path on the herd's machine, which the server can
   *  neither resolve nor meaningfully store once the two are separate
   *  processes; project-relative means the same thing on both sides and
   *  survives the data dir moving. Absent when the tool leaves no transcript,
   *  or wrote one outside the project directory. */
  transcriptPath?: string
  lastActiveMs?: number
  /** When the herd first saw it, used as its birth if it is new. */
  firstSeenMs?: number
}

/**
 * Which of a worktree's sessions are running right now — the complete
 * live set, so anything linked and unnamed here has stopped.
 *
 * Absence of this event is emphatically NOT an empty set. A herd that cannot
 * see a worktree's agents says nothing, because blanking the set on a
 * transient gap would look like "every agent exited" — and the frozen set is
 * exactly what a restart brings back up.
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
 * A worktree's session went away — a user stop, a project teardown, or a
 * reaper. `cause` is set only when a reaper (not the user) tore it down, so a
 * plain stop cannot inherit an earlier death's reason.
 */
export interface WorktreeStopped {
  type: 'worktree-stopped'
  projectSlug: string
  worktreeId: string
  cause?: WorktreeDeathCause
}
