// The public interface of the db feature. Everything outside this
// directory imports `#db`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature is the durable half of a workspace: every fact a client can
// ask about that no substrate can answer — the title a user typed, the
// sidebar group they filed it under, the creation time that survives a
// restart the runtime did not,
// the conversations a workspace has hosted and what each opened with, and
// how it died.
//
// It owns the database outright — the handle (`client.ts`) and the schema
// (`schema.ts`) are internal modules here. `getDb` and the tables stay off
// this barrel: a layer that could reach either could build its own queries,
// and that is the one thing the discipline exists to prevent. All that
// crosses from the handle is the void-returning `openDb`/`closeDb` pair the
// composition root drives. Observed facts
// enter through
// exactly one door: code that watches the substrate or reads a workspace's
// disk emits a `WorkspaceEvent`, and `applyWorkspaceEvent` alone decides
// which rows that lands in — its per-event mutators are internal, off this
// barrel. Intent (a title, a group, a preference) is written through the
// ordinary functions below, and reads are free to every layer above.
//
// The join paths that read these rows alongside a runtime observation
// (`listActiveWorkspaces`, restart, the stopped listing) deliberately live
// in `#domain/workspaces` next to the verbs they orchestrate, and reach
// in through this barrel like anything else. So does the wire projection
// they share (`toAgentSessionEntry`): the entry it builds is half row and
// half live observation, and what this layer speaks is rows.
//
// It is also where the install's SECRETS live — a project's proxied
// env-var values and the ssh keys git authenticates with — sealed on the
// way in and opened on the way out (better-auth's `symmetricEncrypt`, under
// the key `secret-key.ts` resolves). Sealing stays inside this folder for
// the same reason the handle does: a layer that could reach past it could
// store a secret without it, and every path that ought to encrypt is here.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/db/.

export {
  deleteProjectAgentSessions,
  firstAgentSession,
  firstAgentSessionsFor,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listWorkspaceAgentSessions,
  recordedConversationHandles,
  setAgentSessionCapture,
  type AgentSessionLinkRow,
} from './agent-session-store'
export { applyWorkspaceEvent } from './apply-workspace-event'
export type { DiscoveredSession, WorkspaceEvent } from './events'
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
export { closeDb, openDb } from './client'
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
  isSerializedChord,
  setGitIdentity,
  setShortcutOverride,
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
  setProjectGitCredential,
  type ProjectRow,
} from './project-store'
export {
  claimSpareWorkspace,
  clearWorkspaceStopped,
  deleteProjectWorkspaces,
  deleteSpareWorkspaceRow,
  findWorkspaceRow,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  listProjectWorkspaceIds,
  listWorkspaceRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  restoreSpareWorkspace,
  findWorkspaceByMamaToken,
  setWorkspaceMamaTokenHash,
  setWorkspaceTitle,
  type WorkspaceRow,
} from './workspace-store'
