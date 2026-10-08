import { getGitUserConfig } from './git'
import { getApiClient } from './server-api'

/**
 * If the server has no git identity, set it from the user's local
 * `git config`. The desktop app's auth daemon calls this on start and
 * `yaac auth update` on a browser sign-in, since both run on the user's
 * machine. Never overwrites an existing identity, so a second machine with
 * a different `git config` cannot replace it. Otherwise users set it with
 * `yaac config git-identity`.
 */
export async function seedGitIdentityFromShell(client = getApiClient()): Promise<
  { name: string; email: string } | null
> {
  const { identity: existing } = await client.config['git-identity'].$get()
  if (existing) return existing
  const local = await getGitUserConfig()
  if (!local) return null
  const { identity } = await client.config['git-identity'].$put({ json: local })
  return identity
}
