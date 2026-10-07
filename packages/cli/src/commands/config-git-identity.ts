import { api } from '#commands/api'

export interface ConfigGitIdentityOptions {
  name?: string
  email?: string
}

/**
 * `yaac config git-identity`: print the git identity your projects'
 * workspaces commit under, or set it with `--name` and `--email`.
 *
 * It is stored on the server, per user, and never touches this machine's
 * git config. The auth daemon seeds it from the local git config when it
 * starts, so this command is for users without one (driven only from a
 * shell, or a test install that wants a fake identity).
 */
export async function configGitIdentity(options: ConfigGitIdentityOptions): Promise<void> {
  const { name, email } = options
  if (name === undefined && email === undefined) {
    const { identity } = await api.config['git-identity'].$get()
    console.log(identity ? `${identity.name} <${identity.email}>` : 'You have no git identity set.')
    return
  }
  if (name === undefined || email === undefined) {
    throw new Error('Pass both --name and --email to set the git identity.')
  }
  const { identity } = await api.config['git-identity'].$put({ json: { name, email } })
  console.log(`Git identity: ${identity.name} <${identity.email}>`)
}
