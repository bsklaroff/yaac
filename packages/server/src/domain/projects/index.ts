// Public interface of the sealed projects folder (`#domain/projects`): a
// project's rows and its files on disk. That covers which repos it links
// (the repos themselves are `#domain/repos`), the settings its workspaces
// launch with, the egress allowlist, the ignored paths a stop keeps, the
// Dockerfile and build-dir files, the picture its chip shows, and the
// project lifecycle verbs.
// Nothing below this layer reads project state; a driver that needs a
// project's config is handed it in a launch intent.
//
// Adding a name here widens the interface and requires a unit test in
// packages/server/test/domain/projects/.

export { addProject, createHostedProject, registerStagedProject } from './add'
export { dismissProjectAdd, listProjectAdds } from './adding'
export {
  addProjectRepo,
  projectRepo,
  removeProjectRepo,
  reorderProjectRepos,
  repoOfProject,
  updateProjectRepoLink,
  type RepoToLink,
} from './repos'
export {
  addAllowedHostToProject,
  allowRepoHostWhereLinked,
  getProjectAllowlist,
  setProjectAllowlist,
} from './allowlist'
export { MAX_ICON_BYTES, readProjectIcon, removeProjectIcon, setProjectIcon } from './icon'
export {
  addPortForward,
  cacheVolumesSchema,
  portForwardsSchema,
  resolveProjectConfig,
  updateProjectConfig,
} from './config'
export { importProjectConfigFiles } from './config-import'
export { scratchDirSettingsPatchSchema, setScratchDirs } from './scratch-dirs'
export { setKeptIgnoredPaths } from './kept-paths'
export {
  listProjectEnv,
  parseSecretProxyRule,
  pushProjectSecrets,
  removeProjectEnvVar,
  resolveProjectEnv,
  setProjectEnvVar,
} from './env'
export { listProjectRunSecrets, removeRunSecret, setRunSecret } from './run-secrets'
export {
  admitLaunch,
  ApprovalRequiredError,
  approveContent,
  approveStart,
  approveWorkflowStart,
  assertWorkflowRepos,
  createWorkflow,
  deleteWorkflow,
  editWorkflow,
  listInitWorkflows,
  listProjectWorkflows,
  listWorkflowSummaries,
  missingRepos,
  projectRepoIds,
  resolveWorkflow,
  setInitWorkflows,
  showWorkflow,
  workflowLaunch,
  workflowSpec,
} from './workflows'
export {
  assertProjectExists,
  getProjectDetail,
  resolveProjectId,
} from './detail'
export { listProjects } from './list'
