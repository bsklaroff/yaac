// Public interface of the sealed projects folder (`#domain/projects`): a
// project's rows and its files on disk. That covers the clone and its
// branches, the remote of a project the server hosts, both config layers,
// the egress allowlist, the Dockerfile and build-dir files, which of its
// owner's git credentials it uses, and the project lifecycle verbs.
// Nothing below this layer reads project state; a driver that needs a
// project's config is handed it (`PassContext.projectConfig`, a launch
// intent).
//
// Adding a name here widens the interface and requires a unit test in
// packages/server/test/domain/projects/.

export { addProject, createHostedProject, registerStagedProject, shareProject } from './add'
export { serveHostedRepo, setDefaultBranchGuard } from './hosted'
export {
  addAllowedHostToProject,
  getProjectAllowlist,
  setProjectAllowlist,
} from './allowlist'
export { getProjectBranches } from './branches'
export { fetchProjectOrigin, refreshProjectOrigins } from './origin'
export {
  deleteBuildFile,
  listBuildFiles,
  readBuildFile,
  renameBuildFile,
  writeBuildFile,
} from './build-files'
export {
  resolveEphemeralModulesPaths,
  resolveProjectConfig,
} from './config'
export { dismissImageBuild, retryImageBuild } from './images'
export {
  listProjectEnv,
  parseSecretProxyRule,
  pushProjectSecrets,
  removeProjectEnvVar,
  resolveProjectEnv,
  setProjectEnvVar,
} from './env'
export {
  assignProjectCredential,
  missingCredentialError,
  resolveProjectCredential,
  sshKeyMaterial,
} from './credentials'
export {
  assertProjectExists,
  getProjectDetail,
  projectRemoteUrl,
  resolveProjectId,
  resolveProjectConfigWithSource,
} from './detail'
export {
  readProjectDockerfile,
  readUserDockerfile,
  writeProjectDockerfile,
  writeUserDockerfile,
} from './dockerfile'
export { listProjects } from './list'
export {
  addPortForwardToProjectConfig,
  readProjectConfigRaw,
  removeProjectConfig,
  writeProjectConfig,
} from './local-config'
