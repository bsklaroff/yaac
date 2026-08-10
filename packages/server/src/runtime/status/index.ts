// The public interface of the status feature. Everything outside this
// directory imports `#runtime/status`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature answers two questions about a running worktree, and only
// those: *is it still there* (the tmux/pane liveness probes and the
// terminating marks) and *what is its agent doing* (the watcher-fed status
// store). It reads pods and talks to tmux; it never creates, restarts or
// tears anything down. Worktree teardown calls in here to evict what it
// cached — never the other way round — which is what keeps the dependency
// on `#domain/worktrees` one-directional.
//
// The tri-state liveness verdicts are the reason this is worth sealing.
// `unknown` must never be flattened into `dead` by a caller: the stale
// reaper acts on the verdict, so a cluster blip read as death reaps a
// healthy worktree, Job and vcluster and all, with no recovery. Callers get
// the tri-state or the deliberately-safe boolean, never the probe itself.
//
// What this feature does NOT own is how an agent is observed. That is an
// `AgentDriver` (`#runtime/agents`), picked per worktree from its mode, so
// the watcher's respawn/backoff/self-heal is written once and both `tui`
// and `acp` worktrees run through it. The store keys statuses by the
// driver's opaque handle for a conversation, never by anything
// tmux-shaped.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/status/.

export { classifyWorktreePods, watcherDisplayLiveness } from './classify'
export { worktreeControlStreamSend, type ControlStreamSend } from './control-stream-registry'
export {
  forgetLiveness,
  isTmuxSessionAlive,
  probeAgentPaneState,
  probeTmuxLiveness,
  type AgentPaneState,
  type TmuxLiveness,
} from './liveness'
export {
  evictWorktreeStatus,
  liveAgents,
  onLiveAgentsChanged,
  onWorktreeStatusChanged,
  readAgentStatus,
  readWorktreeStatus,
  readWorktreeWaitingSince,
} from './status-store'
export {
  StatusWatcherManager,
  podAgentMode,
  type StatusWatcherDeps,
  type WatchedWorktree,
} from './status-watcher'
export {
  clearWorktreeTerminating,
  isWorktreeTerminating,
  markWorktreeTerminating,
  pruneTerminating,
} from './terminating'
