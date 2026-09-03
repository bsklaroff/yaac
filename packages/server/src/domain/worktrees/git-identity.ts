import { getGitIdentity } from '#db'

/**
 * The one answer to "which git identity does this worktree commit under".
 *
 * Two paths provision a worktree — a cold `createWorktree` and a claim of a
 * prewarmed spare — and both must reach the same identity, so the chain lives
 * here rather than in either of them. Its rungs, in order:
 *
 *  1. what the caller supplied. Nothing routinely does: the CLI resolves an
 *     identity and SETS it (below) rather than passing one per create, so
 *     this is left for a caller that genuinely has a one-off answer.
 *  2. the server's own setting — a preferences row, edited in the webapp and
 *     seeded from a client's shell by the CLI and the auth server.
 *
 * A setting rather than something read off a host, because the host is not
 * where the user is. Under `k8s` the server is a pod whose `$HOME` is an
 * ephemeral image layer with no git config in it at all, so an install-time
 * snapshot into the Deployment's environment was the only way to answer —
 * which meant changing your name needed a re-install, from a shell on that
 * machine, which a remote user does not have. Under `containerless` the
 * host's global config belongs to whoever runs the server, not to whoever is
 * driving it from a laptop. A row answers for both.
 */
export type GitIdentity = { name: string; email: string }

/**
 * Walk the chain. Returns `null` only when no rung answers, which is the
 * caller's cue to refuse — see `gitIdentityMissingMessage`.
 */
export async function resolveGitIdentity(
  supplied?: GitIdentity,
): Promise<GitIdentity | null> {
  if (supplied) return supplied
  return await getGitIdentity()
}

/**
 * What to tell a user when no rung answers. Names the webapp first because
 * that is the remedy every client has, and the CLI second because it is the
 * one that fills the setting in without anybody typing it twice.
 */
export const gitIdentityMissingMessage =
  'No git identity is set on this server, so a worktree would commit as nobody. '
  + 'Set one in Settings \u2192 General, or run a `yaac` command from a machine whose '
  + 'git config has one (`yaac worktree create` and the auth server both seed it).'
