// Public interface of the sealed repos folder (`#domain/repos`): a user's
// git repos (docs/project-repos.md). That covers each one's main clone and
// its branches, the remote of a repo the server hosts, which of its owner's
// git credentials it uses, and who may use it. Which repos a project links
// is `#domain/projects`; a workspace's checkouts of them, and the verbs
// that stop workspaces (unshare, move, delete), are `#domain/workspaces`.
//
// Adding a name here widens the interface and requires a unit test in
// packages/server/test/domain/repos/.

export { assertCanUseRepo, canUseRepo, ownRepo } from './access'
export { getRepoBranches } from './branches'
export {
  assignRepoCredential,
  missingCredentialError,
  repoCredentialNames,
  resolveCredentialForRemote,
  resolveRepoCredential,
  sshKeyMaterial,
  validateGitRemoteUrl,
} from './credentials'
export {
  removeKeptHostedRepo,
  serveHostedRepo,
  setDefaultBranch,
  setDefaultBranchGuard,
  withRepoHeld,
} from './hosted'
export { moveLegacyMainClones } from './legacy-main-clones'
export { fetchRepoCommit, fetchRepoOrigin, freshenOrigin, onOriginFetched, refreshRepoOrigins, seedRepoOrigin } from './origin'
export { addRepo, createHostedRepo, listRepoSummaries, registerStagedRepo, shareRepo } from './repos'
