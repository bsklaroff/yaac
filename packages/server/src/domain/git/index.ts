// Public interface of the sealed git folder (`#domain/git`), the server's
// only process boundary onto git (docs/server-git.md):
//  - `transport.ts` turns a resolved credential into a git invocation;
//  - `agent.ts` is the ssh-agent that invocation signs through;
//  - `repo.ts` operates on a project's main clone and creates the checkouts
//    that borrow from it;
//  - `run.ts` starts every git process, with hooks and transports pinned;
//  - `peer-bundle.ts` reads a checkout's git without running git, through
//    the `peer-reader.ts` child process.
//
// It lives in domain because nothing under `src/runtime` runs git (drivers
// mount checkouts, they don't make them). Adding a name here widens the
// interface and requires a unit test in packages/server/test/domain/git/.

export {
  fetchKnownHostsEntry,
  gitEnvForCredential,
  injectTokenIntoUrl,
  isGitAuthError,
  torEnv,
  writeKnownHostsFile,
  type ResolvedGitCredential,
} from './transport'
export { startGitSshAgent, stopGitSshAgent } from './agent'
export {
  cloneRepo,
  createCheckout,
  fetchOrigin,
  getDefaultBranch,
  lastFetchedAtMs,
  listRemoteBranches,
  listTreeSubdirs,
  maintainRepo,
  readBlobAt,
  remoteBranchExists,
  resolveRemoteRef,
} from './repo'
export { bundleCheckout } from './peer-bundle'
