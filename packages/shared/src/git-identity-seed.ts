import { getGitUserConfig } from './git'
import { getApiClient } from './server-api'

/**
 * If the server has no git identity, set it from the user's local
 * `git config`. The auth server calls this on start, since it runs on the
 * user's machine. Never overwrites an existing identity, so a second
 * machine with a different `git config` cannot replace it. Without the auth
 * server, users set it with `yaac config git-identity`.
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
