import { api } from '#commands/api'

export interface ConfigGitIdentityOptions {
  name?: string
  email?: string
}

/**
 * `yaac config git-identity`: print the git identity the server's worktrees
 * commit under, or set it with `--name` and `--email`.
 *
 * It is a server setting, so this edits the server's answer, never this
 * machine's git config. The auth server seeds it from that config when it
 * starts; this is how to set it without one — a server driven only from a
 * shell, or a fake identity for a test install.
 */
export async function configGitIdentity(options: ConfigGitIdentityOptions): Promise<void> {
  const { name, email } = options
  if (name === undefined && email === undefined) {
    const { identity } = await api.config['git-identity'].$get()
    console.log(identity ? `${identity.name} <${identity.email}>` : 'No git identity is set on this server.')
    return
  }
  if (name === undefined || email === undefined) {
    console.error('Pass both --name and --email to set the git identity.')
    process.exitCode = 1
    return
  }
  const { identity } = await api.config['git-identity'].$put({ json: { name, email } })
  console.log(`Git identity: ${identity.name} <${identity.email}>`)
}
