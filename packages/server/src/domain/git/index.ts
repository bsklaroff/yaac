// The public interface of git: the server's process boundary onto the
// `simple-git` dependency. Two halves — `transport.ts` turns a resolved
// credential into a runnable git invocation, `repo.ts` runs the operations
// against a project's clone and the worktrees cut from it.
//
// Not yet the ONLY boundary, and worth saying so rather than implying
// otherwise: `domain/worktrees/prewarm.ts` (one `revparse`) and
// `domain/skills/discover.ts` (`ls-tree` / `show` against a ref) still drive
// simple-git themselves. Both are one-off reads with no credential in them,
// both predate this folder, and neither breaks a layer rule — every one of
// them is in domain. Absorbing them means naming two more verbs here, which
// is a follow-up rather than a reason to leave the boundary undescribed.
//
// A domain module rather than a lower layer for two reasons: nothing under
// `src/runtime` runs git (a driver mounts a checkout, it does not make one),
// and `#lib` takes no third-party dependency. Everything outside this
// directory imports `#domain/git`; the SEALED_FOLDERS lint rule stops src
// from reaching past this file. Adding a name here widens the interface and
// obliges a unit test in packages/server/test/domain/git/.

export {
  buildHostSideGitSshCommand,
  gitEnvForCredential,
  sweepSshKeyScratch,
  withSshKeyFile,
  injectTokenIntoUrl,
  isGitAuthError,
  torEnv,
  writeKnownHostsFile,
  type ResolvedGitCredential,
} from './transport'
export {
  addWorktree,
  cloneRepo,
  fetchOrigin,
  getDefaultBranch,
  listRemoteBranches,
  originRemoteUrl,
  remoteBranchExists,
  worktreeUpstreamBranch,
} from './repo'
