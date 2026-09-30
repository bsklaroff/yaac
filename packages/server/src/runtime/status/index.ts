// Barrel for `#runtime/status`. It answers two questions about a running
// workspace: is it still there (tmux/pane liveness probes, terminating
// marks) and what is its agent doing (the watcher-fed status store). It
// observes only; teardown calls in here to evict cached state, never the
// reverse.
//
// Liveness is tri-state, and `unknown` must never be treated as `dead`: the
// stale reaper acts on the verdict, so a cluster blip read as death would
// destroy a healthy workspace. Callers get the tri-state or a safe boolean,
// never the raw probe.
//
// How an agent is observed belongs to its `AgentDriver` (`#runtime/agents`),
// so the watcher's respawn/backoff logic serves both `tui` and `acp`. The
// store keys statuses by the driver's opaque conversation handle.
//
// Each export needs a unit test in packages/server/test/runtime/status/.

export { classifyWorkspaces } from './classify'
export { observeWorkspaces, type WorkspaceRuntimeReport } from './observe'
export { workspaceControlStreamSend, type ControlStreamSend } from './control-stream-registry'
export {
  forgetLiveness,
  isTmuxSessionAlive,
  probeAgentPaneState,
  probeTmuxLiveness,
  type ProbeTarget,
  type TmuxLiveness,
} from './liveness'
export {
  evictWorkspaceStatus,
  liveAgents,
  onLiveAgentsChanged,
  onStreamHealthLost,
  readWorkspaceStatus,
  readWorkspaceWaitingSince,
} from './status-store'
export {
  StatusWatcherManager,
  type WatchedWorkspace,
} from './status-watcher'
export {
  clearWorkspaceTerminating,
  isWorkspaceTerminating,
  markWorkspaceTerminating,
  pruneTerminating,
} from './terminating'
