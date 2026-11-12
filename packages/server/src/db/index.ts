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
  deleteProjectConversations,
  getConversationsFor,
  getProjectConversations,
  listActiveConversations,
  listUncapturedStoppedConversations,
  listWorkspaceConversations,
  conversationTitle,
  openingPrompt,
  type ConversationLinkRow,
} from './conversation-store'
export {
  closeSessionRow,
  getSessionRow,
  holdSessionPrompt,
  insertSession,
  listOpenSessionsFor,
  listWorkspaceSessions,
  markSessionsLaunched,
  recordSessionWaitingSeen,
  sessionWindowName,
  setSessionAgentOptions,
  setSessionTitle,
  takeSessionPrompt,
  type SessionLaunchSettings,
  type SessionRow,
} from './session-store'
export {
  insertAddedSteps,
  listStepsFor,
  listWorkspaceSteps,
  resetSteps,
  type LifeWorkflow,
  type StepKey,
  type StepRow,
} from './step-store'
export { applyWorkspaceEvent } from './apply-workspace-event'
export {
  claimVolume,
  deleteProjectVolumeRows,
  deleteVolumeRow,
  findVolumeByName,
  getVolumeRow,
  insertVolume,
  leaseOf,
  listHeldVolumes,
  listProjectVolumes,
  listUnpinnedVolumes,
  listDeletedVolumeIds,
  forgetDeletedVolume,
  listVolumeWorkspaces,
  setVolumeSize,
  setWorkspaceVolume,
  stageVolume,
  handOverVolume,
  listStagedVolumes,
  unstageVolume,
  type VolumeLease,
  type VolumeRow,
} from './volume-store'
export {
  beginSiteDeploy,
  deleteProjectSiteRows,
  deleteSiteRow,
  findSiteByName,
  getSiteRow,
  insertSite,
  listProjectSites,
  listSiteReleases,
  listSites,
  listVolumeSites,
  siteBuiltFrom,
  siteNames,
  updateSite,
  type SitePatch,
  type SiteRow,
} from './site-store'
export type { CapturedConversation, DiscoveredConversation, WorkspaceEvent } from './events'
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
  deleteCustomEndpoint,
  getCustomEndpoint,
  insertCustomEndpoint,
  listCustomEndpoints,
  updateCustomEndpoint,
  type CustomEndpointRow,
} from './custom-endpoint-store'
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
  deleteProjectRunSecrets,
  deleteRunSecret,
  listRunSecrets,
  upsertRunSecret,
  type RunSecretRow,
} from './run-secret-store'
export {
  addWorkflowApproval,
  deleteNamedWorkflow,
  deleteProjectWorkflows,
  deleteUnnamedWorkflows,
  findNamedWorkflow,
  getNamedWorkflow,
  getWorkflow,
  insertNamedWorkflow,
  listNamedWorkflows,
  listWorkflowApprovals,
  setInitWorkflows,
  storeWorkflow,
  updateNamedWorkflow,
  workflowApproved,
  workflowRanAt,
  type NamedWorkflowRow,
  type WorkflowRow,
} from './workflow-store'

export {
  deleteProjectIcon,
  deleteProjectRow,
  getProjectIcon,
  getProjectRow,
  listProjectIconHashes,
  listProjectRows,
  recordProject,
  recordProjectCreate,
  setProjectConfig,
  setProjectEgressAllowlist,
  addProjectEgressHost,
  setProjectScratchDirs,
  setProjectIcon,
  setProjectOrder,
  setProjectKeptIgnoredPaths,
  setProjectWorkspaceRetention,
  type ProjectIcon,
  type ProjectRow,
} from './project-store'
export {
  addRepoShare,
  clearRepoKeepsHostedRepo,
  deleteRepoRow,
  findOwnerRepo,
  getRepo,
  insertRepo,
  linkProjectRepo,
  listAllProjectRepos,
  listProjectRepos,
  listReleasedDeletedRepos,
  listRepoHolders,
  listRepos,
  listRepoShares,
  listWorkspaceRepos,
  listWorkspaceReposFor,
  markRepoDeleted,
  removeRepoShares,
  repointProjectRepos,
  setProjectRepoOrder,
  setRepoDefaultBranchGuard,
  setRepoGitCredential,
  setRepoRemote,
  unlinkProjectRepo,
  updateProjectRepo,
  type ProjectRepoLink,
  type RepoRow,
  type WorkspaceRepoRow,
} from './repo-store'
export {
  deleteToolCredential,
  getToolCredential,
  listToolCredentials,
  setToolCredential,
} from './tool-credential-store'
export {
  BUILT_IN_USER_ID,
  getUser,
  listAdmins,
  listUsers,
  readAccessMode,
  recordAccessMode,
  replaceAdmins,
  seeTailnetUser,
  setUserRole,
} from './user-store'
export {
  backfillWorkspaceScratchDirs,
  countStoppedWorkspaces,
  forgetWorkspaceScratchDirs,
  deleteProjectWorkspaces,
  deleteWorkspaceRecords,
  findWorkspaceRow,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  listStoppedWorkspaceRows,
  listUncleanedStoppedWorkspaces,
  listOverdueWorkspaceRows,
  listWorkspaceRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  findWorkspaceByMamaToken,
  setWorkspaceMamaTokenHash,
  setWorkspaceDeadline,
  markDeadlineIsNextRun,
  setWorkspaceGeneratedTitle,
  setWorkspaceTitle,
  type StoppedCount,
  type StoppedRowCursor,
  type WorkspaceRow,
} from './workspace-store'
