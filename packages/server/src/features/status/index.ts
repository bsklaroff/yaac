// The public interface of the status feature. Everything outside this
// directory imports `#features/status`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature answers two questions about a running session, and only
// those: *is it still there* (the tmux/pane liveness probes and the
// terminating marks) and *what is its agent doing* (the watcher-fed status
// store). It reads pods and talks to tmux; it never creates, restarts or
// tears anything down. Session teardown calls in here to evict what it
// cached — never the other way round — which is what keeps the dependency
// on `#features/sessions` one-directional.
//
// The tri-state liveness verdicts are the reason this is worth sealing.
// `unknown` must never be flattened into `dead` by a caller: the stale
// reaper acts on the verdict, so a cluster blip read as death reaps a
// healthy session, Job and vcluster and all, with no recovery. Callers get
// the tri-state or the deliberately-safe boolean, never the probe itself.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/status/. Modules not re-exported are
// internal: `control-mode.ts` is the tmux protocol client the watcher
// holds, covered through the watcher.

export { classifySessionPods, watcherDisplayLiveness } from './classify'
export { sessionControlStreamSend, type ControlStreamSend } from './control-stream-registry'
export {
  forgetLiveness,
  isTmuxSessionAlive,
  probeAgentPaneState,
  probeTmuxLiveness,
  type AgentPaneState,
  type TmuxLiveness,
} from './liveness'
export {
  evictSessionStatus,
  liveAgentPanes,
  onSessionStatusChanged,
  readPaneStatus,
  readSessionStatus,
  readSessionWaitingSince,
} from './status-store'
export { StatusWatcherManager } from './status-watcher'
export {
  clearSessionTerminating,
  isSessionTerminating,
  markSessionTerminating,
  pruneTerminating,
} from './terminating'
