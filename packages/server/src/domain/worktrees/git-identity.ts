/**
 * The one answer to "which git identity does this worktree commit under".
 *
 * Two paths provision a worktree — a cold `createWorktree` and a claim of a
 * prewarmed spare — and both must reach the same identity, so the chain lives
 * here rather than in either of them. Its rungs, in order:
 *
 *  1. what the caller supplied. The interactive CLI resolves (and prompts
 *     for) an identity before calling; non-interactive callers — the webapp's
 *     stream picker, a `yaac-mama` spawn, `POST /worktrees` — send none.
 *  2. the identity the server's own environment states
 *     (`YAAC_SERVER_GIT_*`, put there by `yaac cluster install`).
 *  3. the host's global git config.
 *
 * Rungs 2 and 3 are both needed because only one answers per placement. Under
 * `k8s` the server is a pod whose `$HOME` is an ephemeral image layer with no
 * git config to read, and only the env var answers; under `containerless` it
 * is a host process that is never given the env var, and the global config is
 * the answer.
 */
import { env as yaacEnv } from '@yaac/shared/env'
import { getGitUserConfig } from '@yaac/shared/git'

export type GitIdentity = { name: string; email: string }

/**
 * Walk the chain. Returns `null` only when no rung answers, which is the
 * caller's cue to refuse — see `gitIdentityMissingMessage`.
 */
export async function resolveGitIdentity(
  supplied?: GitIdentity,
): Promise<GitIdentity | null> {
  if (supplied) return supplied
  if (yaacEnv.serverGitUser) return yaacEnv.serverGitUser
  return await getGitUserConfig()
}

/**
 * What to tell a user when every rung came up empty. Names both remedies
 * because the one that works depends on the placement, which the user knows
 * and this code does not need to branch on.
 */
export const gitIdentityMissingMessage =
  'No git identity available for non-interactive session creation. '
  + 'Configure one globally (git config --global user.name / user.email), '
  + 'then, on a k8s install, re-run `yaac cluster install` so the server '
  + 'pod is given it.'
