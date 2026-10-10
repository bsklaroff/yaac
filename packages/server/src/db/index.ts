// Public interface of the sealed db folder (`#db`); see docs/layered-server.md.
//
// It stores what no substrate can answer: titles, groups, creation times,
// the conversations a workspace hosted, how it died, and the install's
// secrets.
//
// The handle (`client.ts`) and schema (`schema.ts`) stay off this barrel so
// no other layer can build its own queries; only `openDb`/`closeDb` and the
// `MigrationRefusal` that `openDb` can throw are exported, for the
// composition root. Observed facts enter only as a `WorkspaceEvent`
// through `applyWorkspaceEvent`, which decides which rows change. User
// intent (a title, a group, a preference) is written through the plain
// functions below.
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
  firstAgentSessionsFor,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listUncapturedStoppedSessions,
  listWorkspaceAgentSessions,
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
  setWorkspaceGroupPinned,
} from './group-store'
export { closeDb, MigrationRefusal, openDb } from './client'
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
  listQueuedWorkspaceRows,
  releaseQueuedChildren,
  releaseQueuedWorkspace,
  setQueuedWorkspaceTitle,
  updateQueuedWorkspace,
  type QueuedParent,
  type QueuedWorkspaceRow,
  type QueuedWorkspaceSettings,
} from './queued-workspace-store'
export {
  clearShortcutOverrides,
  getGitIdentity,
  getShortcutOverrides,
  getTimeZone,
  isSerializedChord,
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
  setProjectEgressAllowlist,
  setProjectGitCredential,
  type ProjectRow,
} from './project-store'
export {
  deleteToolCredential,
  getToolCredential,
  listToolCredentials,
  setToolCredential,
  type ToolCredential,
} from './tool-credential-store'
export {
  BUILT_IN_USER_ID,
  listUsers,
  readAccessMode,
  recordAccessMode,
  seeTailnetUser,
} from './user-store'
export {
  claimSpareWorkspace,
  clearWorkspaceStopped,
  countStoppedWorkspaces,
  deleteProjectWorkspaces,
  deleteSpareWorkspaceRow,
  findWorkspaceRow,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  listProjectWorkspaceIds,
  listStoppedWorkspaceRows,
  listWorkspaceRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  restoreSpareWorkspace,
  findWorkspaceByMamaToken,
  setWorkspaceMamaTokenHash,
  setWorkspaceTitle,
  type StoppedCount,
  type StoppedRowCursor,
  type WorkspaceRow,
} from './workspace-store'
