// The public interface of the workspaces feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns a workspace's life: creating, starting, restarting,
// stopping, reaping and deleting it, and its rows; the `yaac-mama` commands
// an agent runs against its siblings; and the file editor's reads and writes of a
// workspace's checkout. It drives the runtime only through
// `#drivers/driver` and `#drivers/contract`, and uses `#runtime/agents` and
// `#runtime/status`. The reconcile entry points are idempotent, since the
// background loop calls them every tick.
//
// Each name added here needs a unit test in
// packages/server/test/domain/workspaces/.

export { reconcileAgentSessions, reconcileStoppedAgentSessions } from './agent-session-registry'
export { toAgentSessionEntry } from './agent-session-entry'
export { gcOrphanEphemeralModuleDirs, reapOrphanNodeLocal } from './cleanup'
export { deleteWorkspace } from './delete'
export {
  getWorkspaceBlockedHosts,
  getWorkspaceDetail,
} from './detail'
export { allowWorkspaceHost } from './allow-host'
export { listWorkspaceGroups, resolveGroup } from './groups'
export { moveWorkspaceToGroup, removeWorkspaceGroup, setGroupWorkspaceLimit } from './group-edits'
export { dismissWorkspacePort, forwardWorkspacePort, unforwardWorkspacePort } from './forward-port'
export { listActiveWorkspaces } from './list'
export {
  claimDraft,
  discardDraftWorkspace,
  listDraftWorkspaces,
  saveDraftWorkspace,
} from './drafts'
export { reconcileRevokedShares, removeProject, unshareProject } from './project-teardown'
export { recordedLaunch } from './prewarm'
export { reconcilePrewarmPool } from './prewarm-reconcile'
export { dismissProvisioning, listProvisioning } from './provisioning'
export {
  discardQueuedWorkspace,
  listHeldWorkspaces,
  listQueuedWorkspaces,
  queueWorkspace,
  resumeQueuedWorkspaces,
  runQueuedWorkspace,
  startScheduledWorkspaces,
  updateQueuedWorkspace,
  type QueueStart,
} from './queued-workspaces'
export {
  resolveProjectWorkspace,
  resolveWorkspaceContainer,
  resolveWorkspaceId,
  resolveWorkspaceRecord,
} from './resolve'
export { previewWorkspaceRetention, reconcileWorkspaceRetention, setWorkspaceRetention } from './retention'
export { prepareRestart } from './restart'
export { prepareStart } from './start'
export { reconcileStaleWorkspaces } from './stale-workspaces'
export { stopWorkspace } from './stop'
export {
  createRoutine,
  deleteRoutine,
  listRoutineRunPage,
  listRoutines,
  reconcileRoutines,
  runRoutineNow,
  setRoutinePaused,
  updateRoutine,
} from './routines'
export { reconcileWorkspaceTimeouts, setWorkspaceTimeout } from './timeouts'
export { markWaitingSeen } from './waiting-seen'
export { listStoppedWorkspaces } from './stopped-list'
export { getAcpStoredImage, getAgentSessionTranscript, recordOrigin } from './transcript'
export { observeConversation } from './history-tail'
export { saveWorkspaceAttachment } from './attachments'
export {
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceChangeDiffs,
  getWorkspaceChanges,
  listWorkspaceDir,
  readWorkspaceFile,
  readWorkspaceFileAtRev,
  readWorkspaceMedia,
  renameWorkspaceEntry,
  uploadWorkspaceFile,
  writeWorkspaceFile,
} from './files'
export { runMamaCommand } from './mama'
export { convergeAgentHistory, removeAgentHistory } from './history'
export { reconcileGeneratedTitles } from './title-generation'
export { serverUsageReport } from './usage-report'
