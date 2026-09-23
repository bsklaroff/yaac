// The public interface of git: the server's only process boundary onto
// git. Four parts — `transport.ts` turns a resolved credential into a
// runnable git invocation, `agent.ts` is the ssh-agent that invocation signs
// through, `repo.ts` runs the operations against a project's clone and the
// worktrees cut from it, and `run.ts` is how every one of them starts git
// without letting it read the pod-writable config (docs/server-git.md) —
// public only for the startup sweep of its scratch.
//
// A domain module rather than a lower layer for two reasons: nothing under
// `src/runtime` runs git (a driver mounts a checkout, it does not make one),
// and `#lib` takes no third-party dependency. Everything outside this
// directory imports `#domain/git`; the SEALED_FOLDERS lint rule stops src
// from reaching past this file. Adding a name here widens the interface and
// obliges a unit test in packages/server/test/domain/git/.

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
export { clearGitScratch } from './run'
export {
  addWorktree,
  cloneRepo,
  fetchOrigin,
  getDefaultBranch,
  listCheckoutFiles,
  listRemoteBranches,
  listTreeSubdirs,
  readBlobAt,
  remoteBranchExists,
  resolveRemoteRef,
  worktreeUpstreamBranch,
} from './repo'
