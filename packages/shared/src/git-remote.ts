/**
 * A project's git remote as the server reads it, and whether a credential
 * fits it. Free of imports so the webapp shows the same credential kind and
 * project name the server will use.
 */

export interface ParsedGitRemote {
  scheme: 'https' | 'ssh'
  host: string
  path: string
}

// The path may not start with `/` (`scheme://`) or `:` (`helper::`): git
// would read either as a transport, and `ext::` runs a command.
const SCP_REGEX = /^(?:([\w._-]+)@)?([\w.-]+):(?![/:])(.+)$/

/**
 * Parse a git remote URL in one of two forms:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: [user@]<host>:<path>[.git]
 * `<path>` may be any depth. Throws on ssh://, http://, explicit ports, or
 * unparseable input. A trailing slash is stripped so the last path segment
 * (used for the project name) is the repo name.
 */
export function parseGitRemote(remoteUrl: string): ParsedGitRemote {
  if (remoteUrl.startsWith('ssh://')) {
    throw new Error(
      'ssh:// URLs are not supported. Use SCP-style: git@host:path/to/repo',
    )
  }
  if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
    const url = new URL(remoteUrl)
    if (url.protocol !== 'https:') {
      throw new Error(`Only HTTPS URLs are supported, got "${url.protocol}"`)
    }
    if (url.port) {
      throw new Error(`Custom HTTPS ports are not supported: "${remoteUrl}"`)
    }
    const path = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'https', host: url.hostname, path }
  }
  const m = SCP_REGEX.exec(remoteUrl)
  if (m) {
    const host = m[2]
    const path = m[3].replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'ssh', host, path }
  }
  throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
}

/**
 * Whether a project's assigned credential is usable as is: it is the
 * project owner's, its kind matches the remote's scheme, and an ssh key has
 * a trusted host key. Anything else (such as a changed remote) counts as no
 * credential, so the user is asked for one.
 */
export function usableAssignment<C extends { owner: string; kind: 'https' | 'ssh' }>(
  project: { owner: string; remoteUrl: string; knownHostsEntry: string | null },
  cred: C | undefined,
): cred is C {
  if (cred?.owner !== project.owner) return false
  let scheme: 'https' | 'ssh'
  try {
    scheme = parseGitRemote(project.remoteUrl).scheme
  } catch {
    return false
  }
  return cred.kind === scheme && (scheme === 'https' || project.knownHostsEntry !== null)
}
