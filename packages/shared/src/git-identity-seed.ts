import { getGitUserConfig } from './git'
import { getApiClient } from './server-api'

/**
 * Give the server a git identity from the machine the user is actually on,
 * when it has none.
 *
 * The identity a worktree commits under is a server setting, because a value
 * only a host shell can set is a value a remote user cannot (see
 * `#domain/worktrees`'s `resolveGitIdentity`). But nobody wants to type their
 * own name into a settings page the first time they use yaac, and the answer
 * is already sitting in their `git config` — on THEIR machine, which is
 * exactly where the CLI and the auth server run.
 *
 * So both seed it: whichever runs first fills the setting in, and after that
 * this is one cheap GET. It never overwrites — an identity the user set in
 * the webapp is a deliberate answer, and a second laptop with a different
 * `git config` must not silently take it over.
 */
export async function seedGitIdentityFromShell(): Promise<
  { name: string; email: string } | null
> {
  const client = getApiClient()
  const { identity: existing } = await client.config['git-identity'].$get()
  if (existing) return existing
  const local = await getGitUserConfig()
  if (!local) return null
  const { identity } = await client.config['git-identity'].$put({ json: local })
  return identity
}
