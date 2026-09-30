// The public interface of the workspaces feature. Everything outside this
// directory imports `#domain/workspaces`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This feature owns a workspace's *life*: deciding what one should be,
// starting it, restarting it, stopping it, reaping it when it dies, and
// the rows that record all of that. What it never owns is how any of that
// becomes a running thing — it drives the registered runtime through
// `#drivers/driver` and speaks only `#drivers/contract` vocabulary, so
// nothing here names a Job, a label or a namespace. It composes the two
// runtime verticals that are agent rather than substrate knowledge:
// `#runtime/agents` builds its windows, and `#runtime/status` holds the
// observations it evicts on teardown. Neither imports back, which is what
// keeps the graph acyclic and both testable without a workspace.
//
// The reconcile entry points at the bottom are the background loop's half
// of the same job: every one is idempotent and self-gating, because the
// loop calls them on a fixed tick with no memory of the last pass.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/workspaces/. Modules not re-exported are
// internal: the seed/workspace-bin staging is covered through `createWorkspace`.

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
