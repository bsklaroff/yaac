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
// An ssh:// URL is matched here rather than by `new URL`, which decodes it
// differently from git: git percent-decodes the whole URL before cutting
// the host at the first `/`, so the two can name different hosts. Holding
// the user and host to the SCP characters leaves nothing to decode.
const SSH_URL_REGEX = /^ssh:\/\/(?:([\w.-]+)@)?([\w.-]+)\/(.*)$/
const SSH_PORT_REGEX = /^ssh:\/\/(?:[\w.-]+@)?[\w.-]+:\d+\//

/**
 * Parse a git remote URL in one of three forms:
 *   - https://<host>/<path>[.git]
 *   - ssh://[user@]<host>/<path>[.git]
 *   - SCP-style: [user@]<host>:<path>[.git]
 * `<path>` may be any depth. Throws on other schemes, explicit ports, or
 * unparseable input. A trailing slash is stripped so the last path segment
 * (used for the project name) is the repo name.
 */
export function parseGitRemote(remoteUrl: string): ParsedGitRemote {
  let scheme: ParsedGitRemote['scheme']
  let host: string
  let rawPath: string
  if (remoteUrl.startsWith('https://')) {
    const url = new URL(remoteUrl)
    if (url.port) throw new Error(`Custom ports are not supported: "${remoteUrl}"`)
    scheme = 'https'
    host = url.hostname
    rawPath = url.pathname.replace(/^\//, '')
  } else if (remoteUrl.startsWith('ssh://')) {
    if (SSH_PORT_REGEX.test(remoteUrl)) throw new Error(`Custom ports are not supported: "${remoteUrl}"`)
    const m = SSH_URL_REGEX.exec(remoteUrl)
    if (!m) throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
    scheme = 'ssh'
    host = m[2]
    rawPath = m[3]
  } else if (/^[a-z][\w+.-]*:\/\//i.test(remoteUrl)) {
    throw new Error(`Only https:// and ssh:// URLs are supported, got "${remoteUrl}"`)
  } else {
    const m = SCP_REGEX.exec(remoteUrl)
    if (!m) throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
    scheme = 'ssh'
    host = m[2]
    rawPath = m[3]
  }
  const path = rawPath.replace(/\/$/, '').replace(/\.git$/, '')
  if (!path) throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
  return { scheme, host, path }
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
