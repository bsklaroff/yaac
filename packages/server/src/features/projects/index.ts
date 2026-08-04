// The public interface of the projects feature. Everything outside this
// directory imports `#features/projects`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// A project is a cloned repo plus the per-machine state hanging off it, so
// this interface is wide: the lifecycle (add/remove/list/detail), the two
// config layers (the parsed yaac-config.json and the editors that write it),
// the image build dir and its files, the branch list, and the git
// credentials every one of those leans on. Adding a name here widens the
// interface and obliges a unit test in
// packages/server/test/features/projects/. Everything not re-exported —
// the config parser, the credentials file reader, the pure config
// transforms, the legacy build-dir migration — is internal, and covered
// through the entry points below.

export { addProject } from './add'
export { getProjectBranches } from './branches'
export { PROJECT_DOCKERFILE, USER_DOCKERFILE, resolveProjectBuildDir, resolveUserBuildDir } from './build-dirs'
export { deleteBuildFile, listBuildFiles, readBuildFile, renameBuildFile, writeBuildFile } from './build-files'
export { ephemeralModulesSlotKey, resolveEphemeralModulesPaths, resolveProjectConfig } from './config'
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
export type { ResolvedGitCredential } from './credentials'
export { assertProjectExists, getProjectDetail, resolveProjectConfigWithSource } from './detail'
export { readProjectDockerfile, readUserDockerfile, writeProjectDockerfile, writeUserDockerfile } from './dockerfile'
export { seedFakeAuth } from './fake-auth'
export { readAllGitAuthFailures, readGitAuthFailures } from './git-auth-failures'
export { listProjects } from './list'
export {
  addAllowedHostToProjectConfig,
  addPortForwardToProjectConfig,
  readProjectConfigRaw,
  removeProjectConfig,
  setProjectReferenceBranch,
  writeProjectConfig,
} from './local-config'
export {
  DEFAULT_TOOL_KEY,
  SESSIONS_BACKFILLED_KEY,
  TRANSCRIPT_PATHS_RESOLVED_KEY,
  clearShortcutOverrides,
  getDefaultTool,
  getShortcutOverrides,
  clearFlag,
  isFlagSet,
  isSerializedChord,
  isValidTool,
  setDefaultToolChecked,
  setFlag,
  setShortcutOverride,
} from './preferences'
export { removeProject } from './remove'
