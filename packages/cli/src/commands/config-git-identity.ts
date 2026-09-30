import { api } from '#commands/api'

export interface ConfigGitIdentityOptions {
  name?: string
  email?: string
}

/**
 * `yaac config git-identity`: print the git identity the server's workspaces
 * commit under, or set it with `--name` and `--email`.
 *
 * This is a server setting; it never touches this machine's git config. The
 * auth daemon seeds it from the local git config when it starts, so this
 * command is for servers without one (driven only from a shell, or a test
 * install that wants a fake identity).
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
