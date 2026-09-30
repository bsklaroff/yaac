// The public interface of the workspaces feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns a workspace's life: creating, starting, restarting,
// stopping and reaping it, and its rows. It drives the runtime only through
// `#drivers/driver` and `#drivers/contract`, and uses `#runtime/agents` and
// `#runtime/status`. The reconcile entry points are idempotent, since the
// background loop calls them every tick.
//
// Each name added here needs a unit test in
// packages/server/test/domain/workspaces/.

export { reconcileAgentSessions } from './agent-session-registry'
export { toAgentSessionEntry } from './agent-session-entry'
export {
  cleanupWorkspaceDetached,
  gcOrphanEphemeralModuleDirs,
  teardownForRestart,
} from './cleanup'
export { convertLinkedCheckouts } from './linked-checkouts'
export {
  createWorkspace,
  resolveCreate,
  type CreateSetup,
  type WorkspaceCreateOptions,
  type WorkspaceCreateResult,
} from './create'
export {
  getWorkspaceBlockedHosts,
  getWorkspaceChanges,
  getWorkspaceDetail,
  getWorkspacePrompt,
} from './detail'
export { allowWorkspaceHost } from './allow-host'
export { saveWorkspaceAttachment } from './attachments'
export {
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceGitStatus,
  listWorkspaceDir,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceEntry,
  writeWorkspaceFile,
} from './files'
export { listWorkspaceGroups, resolveGroup } from './groups'
export { dismissWorkspacePort, forwardWorkspacePort } from './forward-port'
export { listActiveWorkspaces } from './list'
export { purgeProjectBytes } from './project-purge'
export { discardDraftWorkspace, draftGeneratedTitle, listDraftWorkspaces, saveDraftWorkspace } from './drafts'
export { removeProject } from './project-teardown'
export { reconcilePrewarmPool } from './prewarm-reconcile'
export {
  inFlightWorkspaceIds,
  listProvisioning,
  registerProvisioning,
  removeProvisioning,
  runProvisioned,
} from './provisioning'
export {
  discardQueuedWorkspace,
  listHeldWorkspaces,
  listQueuedWorkspaces,
  queueWorkspace,
  reconcileQueuedWorkspaces,
  runQueuedWorkspace,
  updateQueuedWorkspace,
} from './queued-workspaces'
export {
  resolveWorkspace,
  resolveWorkspaceContainer,
  resolveWorkspaceId,
  resolveWorkspaceRecord,
} from './resolve'
export { resolveRestartTarget, restartWorkspace } from './restart'
export { startWorkspace } from './start'
export { rebranchSpare, retoolSpare } from './spare-pool'
export { runMamaCommand, type MamaCaller } from './mama'
export { reconcileMamaRequests } from './mama-reconcile'
export { reconcileStaleWorkspaces } from './stale-workspaces'
export { stopWorkspace } from './stop'
export { listStoppedWorkspaces } from './stopped-list'
export { getAgentSessionTranscript } from './transcript'
