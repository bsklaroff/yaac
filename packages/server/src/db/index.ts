// Public interface of the sealed db folder (`#db`); see docs/layered-server.md.
//
// It stores what no substrate can answer: titles, groups, creation times,
// the conversations a workspace hosted, how it died, and the install's
// secrets.
//
// The handle (`client.ts`) and schema (`schema.ts`) stay off this barrel so
// no other layer can build its own queries; only `openDb`/`closeDb`, the
// `DbRefusal` that `openDb` can throw, and the `pingDb` liveness
// check are exported, for the composition root. Observed facts enter only
// as a `WorkspaceEvent` through `applyWorkspaceEvent`, which decides which
// rows change. User intent (a title, a group, a preference) is written
// through the plain functions below.
//
// Secrets (project env-var values, git and tool credentials) are encrypted
// on write and decrypted on read here (better-auth's `symmetricEncrypt`,
// keyed by `secret-key.ts`), so no path can store one unencrypted.
//
// Adding a name here widens the interface and requires a unit test in
// packages/server/test/db/.

export {
  deleteProjectAgentSessions,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listUncapturedStoppedSessions,
  listWorkspaceAgentSessions,
  conversationTitle,
  openingPrompt,
  recordedConversationHandles,
  type AgentSessionLinkRow,
} from './agent-session-store'
export { applyWorkspaceEvent } from './apply-workspace-event'
export type { CapturedSession, DiscoveredSession, WorkspaceEvent } from './events'
export { desiredWorkspaces } from './desired-workspaces'
export {
  createWorkspaceGroup,
  deleteProjectWorkspaceGroups,
  deleteWorkspaceGroup,
  listWorkspaceGroupRows,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupLimit,
  setWorkspaceGroupPinned,
  type WorkspaceGroupRow,
} from './group-store'
export { closeDb, DbRefusal, openDb, pingDb } from './client'
export {
  deleteDraftWorkspace,
  deleteProjectDraftWorkspaces,
  insertDraftWorkspace,
  listDraftWorkspaceRows,
  setDraftWorkspaceTitle,
  updateDraftWorkspace,
  type DraftWorkspaceRow,
} from './draft-workspace-store'
export {
  claimQueuedLaunch,
  deleteProjectQueuedWorkspaces,
  deleteQueuedWorkspace,
  failQueuedLaunch,
  finishQueuedLaunch,
  getQueuedWorkspaceRow,
  insertQueuedWorkspace,
  insertRoutineRun,
  listQueuedWorkspaceRows,
  releaseDueQueuedWorkspaces,
  releaseQueuedChildren,
  releaseQueuedWorkspace,
  setQueuedWorkspaceTitle,
  updateQueuedWorkspace,
  type QueuedParent,
  type QueuedWorkspaceRow,
  type QueuedWorkspaceSettings,
} from './queued-workspace-store'
export {
  deleteProjectRoutines,
  deleteRoutine,
  getRoutineRow,
  insertRoutine,
  listRoutineRows,
  listRoutineRuns,
  listUnlaunchedRoutineRuns,
  routineRunWorkspaces,
  setRoutinePaused,
  updateRoutine,
  type RoutineFields,
  type RoutineRow,
  type RoutineRunRow,
} from './routine-store'
export {
  clearShortcutOverrides,
  getGitIdentity,
  getShortcutOverrides,
  getTimeZone,
  setGitIdentity,
  setShortcutOverride,
  setTimeZone,
} from './preferences'
export {
  deleteGitCredential,
  getGitCredential,
  getGitCredentialByName,
  insertGitCredential,
  listGitCredentials,
  renameGitCredential,
  replaceGitCredential,
  type GitCredentialRow,
} from './git-credential-store'
export {
  deleteProjectEnvVar,
  deleteProjectEnvVars,
  listProjectEnvVars,
  upsertProjectEnvVar,
  type ProjectEnvVarRow,
} from './project-env-store'
export {
  deleteProjectRow,
  getProjectRow,
  listProjectRows,
  recordProject,
  recordProjectCreate,
  setProjectDefaultBranchGuard,
  setProjectEgressAllowlist,
  setProjectGitCredential,
  setProjectKeptIgnoredPaths,
  setProjectShareRevoked,
  setProjectWorkspaceRetention,
  type ProjectRow,
} from './project-store'
export {
  deleteToolCredential,
  getToolCredential,
  listToolCredentials,
  setToolCredential,
} from './tool-credential-store'
export {
  BUILT_IN_USER_ID,
  listUsers,
  readAccessMode,
  recordAccessMode,
  seeTailnetUser,
} from './user-store'
export {
  clearWorkspaceStopped,
  countStoppedWorkspaces,
  deleteProjectWorkspaces,
  deleteWorkspaceRecords,
  findWorkspaceRow,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  holdPendingPrompt,
  listProjectWorkspaceIds,
  listStoppedWorkspaceRows,
  listUncleanedStoppedWorkspaces,
  listOverdueWorkspaceRows,
  listWorkspaceRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  recordWaitingSeen,
  findWorkspaceByMamaToken,
  setWorkspaceMamaTokenHash,
  setWorkspaceDeadline,
  markDeadlineIsNextRun,
  setWorkspaceGeneratedTitle,
  setWorkspaceTitle,
  takePendingPrompt,
  type StoppedCount,
  type StoppedRowCursor,
  type WorkspaceRow,
} from './workspace-store'
