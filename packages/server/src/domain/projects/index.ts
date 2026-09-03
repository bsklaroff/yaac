// The public interface of the projects feature: a project WHOLE — the rows
// that say which exist, and the disk half those rows name. The clone and its
// branches, the two config layers, the Dockerfile and support files in its
// build dir, and the git credentials every one of those leans on all live
// here now, beside the lifecycle verbs that used to reach across a layer for
// them.
//
// One project has one owner, which is what the merge buys: "which projects
// exist" is a row question and "what is in this one" is a disk question, but
// both are answered here, and nothing below this layer asks either. A driver
// that needs a project's config is handed it (`PassContext.projectConfig`, a
// launch intent) rather than reading it.
//
// Everything outside this directory imports `#domain/projects`; the
// SEALED_FOLDERS lint rule stops src from reaching past this file. Adding a
// name here widens the interface and obliges a unit test in
// packages/server/test/domain/projects/.

export { addProject } from './add'
export { getProjectBranches, type ProjectBranches } from './branches'
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
  resolveEphemeralModulesPaths,
  resolveProjectConfig,
} from './config'
export {
  listProjectEnv,
  parseSecretProxyRule,
  removeProjectEnvVar,
  resolveProjectEnv,
  setProjectEnvVar,
  type ResolvedProjectEnv,
} from './env'
export {
  importLegacyProjectConfig,
  legacySecretImportPending,
} from './legacy-config-import'
export {
  addEntry,
  importLegacySshKeys,
  listEntries,
  listSshEntries,
  loadKnownHostsEntryForHost,
  parseGitRemote,
  removeEntryChecked,
  replaceEntries,
  resolveCredentialForUrl,
  saveCredentials,
} from './credentials'
export { assertProjectExists, getProjectDetail, resolveProjectConfigWithSource } from './detail'
export { readProjectDockerfile, readUserDockerfile, writeProjectDockerfile, writeUserDockerfile } from './dockerfile'
export { seedFakeAuth } from './fake-auth'
export { listProjects } from './list'
export {
  addAllowedHostToProjectConfig,
  addPortForwardToProjectConfig,
  readProjectConfigRaw,
  removeProjectConfig,
  setProjectReferenceBranch,
  writeProjectConfig,
} from './local-config'
