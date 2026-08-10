// The public interface of the projects store: the half of a project that
// lives on disk — the clone, its branches, the two config layers, the image
// build dir and its files, and the git credentials every one of those leans
// on. Which projects EXIST is a records question and lives in
// `#domain/projects` beside the lifecycle verbs. Everything outside this
// directory imports `#store/projects`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Adding a name here widens the interface
// and obliges a unit test in packages/server/test/store/projects/.

export { getProjectBranches, type ProjectBranches } from './branches'
export { PROJECT_DOCKERFILE, USER_DOCKERFILE, resolveProjectBuildDir, resolveUserBuildDir } from './build-dirs'
export {
  deleteBuildFile,
  listBuildFiles,
  readBuildFile,
  renameBuildFile,
  writeBuildFile,
  type BuildFileContent,
  type BuildFileEntry,
} from './build-files'
export {
  ephemeralModulesSlotKey,
  loadProjectConfig,
  resolveEphemeralModulesPaths,
  resolveProjectConfig,
} from './config'
export {
  addEntry,
  listEntries,
  listSshEntries,
  loadKnownHostsEntryForHost,
  parseGitRemote,
  removeEntryChecked,
  replaceEntries,
  resolveCredentialForUrl,
  saveCredentials,
  writeProxySecrets,
} from './credentials'
export { readProjectDockerfile, readUserDockerfile, writeProjectDockerfile, writeUserDockerfile } from './dockerfile'
export { seedFakeAuth } from './fake-auth'
export { readAllGitAuthFailures, readGitAuthFailures } from './git-auth-failures'
export {
  addAllowedHostToProjectConfig,
  addPortForwardToProjectConfig,
  readProjectConfigRaw,
  removeProjectConfig,
  setProjectReferenceBranch,
  writeProjectConfig,
} from './local-config'
