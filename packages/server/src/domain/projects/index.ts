// Public interface of the sealed projects folder (`#domain/projects`): a
// project's rows and its files on disk. That covers the clone and its
// branches, both config layers, the Dockerfile and build-dir files, the git
// credentials, and the project lifecycle verbs. Nothing below this layer
// reads project state; a driver that needs a project's config is handed it
// (`PassContext.projectConfig`, a launch intent).
//
// Adding a name here widens the interface and requires a unit test in
// packages/server/test/domain/projects/.

export { addProject, registerStagedProject } from './add'
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
  removeProjectEnvVar,
  resolveProjectEnv,
  setProjectEnvVar,
} from './env'
export {
  addHttpsCredential,
  assignProjectCredential,
  generateSshCredential,
  listCredentialSummaries,
  missingCredentialError,
  parseGitRemote,
  removeCredential,
  renameCredential,
  replaceCredential,
  resolveProjectCredential,
  runtimeGitCredentials,
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
  moveLegacyUserBuildDir,
  readProjectDockerfile,
  readUserDockerfile,
  writeProjectDockerfile,
  writeUserDockerfile,
} from './dockerfile'
export { seedFakeAuth } from './fake-auth'
export { listProjects } from './list'
export {
  addAllowedHostToProjectConfig,
  addPortForwardToProjectConfig,
  readProjectConfigRaw,
  removeProjectConfig,
  writeProjectConfig,
} from './local-config'
