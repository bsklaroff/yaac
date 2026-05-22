export {
  PACKAGE_ROOT, DOCKERFILES_DIR, PROXY_DIR,
  getDataDir, setDataDir, getProjectsDir, projectDir, repoDir,
  projectConfigDir, claudeDir, claudeJsonFile, projectClaudeCredentialsFile,
  credentialsDir, githubCredentialsPath, claudeCredentialsPath,
  codexCredentialsPath,
  worktreesDir, worktreeDir, ensureDataDir,
} from './paths'
export { expandEnvVars, parseProjectConfig, loadProjectConfig, resolveProjectConfig } from './config'
export { listProjects, type ProjectListEntry } from './list'
export {
  credentialsPath, loadCredentials, saveCredentials,
  validatePattern, parsePattern, matchPattern, parseGitRemote,
  resolveCredentialForUrl, loadKnownHostsEntryForHost,
  addEntry, removeEntry, removeEntryChecked, replaceEntries,
  listEntries, listSshEntries, summarizeEntries,
  promptForHttpsCredential, ensureFirstCredential, assertKeyHasNoPassphrase,
  type ResolvedGitCredential, type ParsedGitRemote,
} from './credentials'
