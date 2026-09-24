import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { env } from '#env'

const execFileAsync = promisify(execFile)

/**
 * ssh does not honor ALL_PROXY / HTTPS_PROXY, so Tor routing for ssh has
 * to go through `-o ProxyCommand=...`. OpenBSD `nc -X 5 -x` passes the
 * destination hostname unchanged to the SOCKS5 proxy, so Tor resolves DNS
 * at its exit (no local-DNS leak). Whatever runs the server must ship
 * OpenBSD `nc` — macOS does, and Dockerfile.server installs
 * `netcat-openbsd` for the in-cluster server.
 *
 * Note: these opts must NOT be passed to `ssh-keyscan` — its `-O` flag
 * only accepts `hashalg`, not ProxyCommand. For host-key fetches under
 * Tor, drive `ssh` instead (see fetchKnownHostsEntry in #domain/git).
 */
export function torSshOpts(): string[] {
  if (!env.useTor) return []
  const url = new URL(env.torSocksUrl)
  const host = url.hostname
  const port = parseInt(url.port || '9050', 10)
  return ['-o', `ProxyCommand=nc -X 5 -x ${host}:${port} %h %p`]
}

/**
 * Join ssh argv into a GIT_SSH_COMMAND string. git tokenizes that env var
 * with shell rules, so an arg containing spaces (e.g. a ProxyCommand value)
 * must be quoted or it word-splits — ssh then sees garbage flags and runs
 * a truncated ProxyCommand. POSIX single-quote escape: replace `'` with
 * `'\''` and wrap in `'…'`. We only quote args that need it so the result
 * stays readable.
 */
export function formatSshCommand(args: string[]): string {
  return args.map(shellQuoteArg).join(' ')
}

function shellQuoteArg(s: string): string {
  if (s !== '' && !/[\s'"\\$`*?|&;<>()#]/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Read the user's global git identity. Returns `null` if either
 * `user.name` or `user.email` is unset, or if `git` itself fails.
 *
 * Lives in shared because both the CLI (which prompts when missing
 * and forwards the resolved pair to the server) and the server
 * (which falls back to the global config during non-interactive
 * worktree creation) need it.
 */
export async function getGitUserConfig(): Promise<{ name: string; email: string } | null> {
  const read = async (key: string): Promise<string> =>
    (await execFileAsync('git', ['config', '--global', '--get', key])).stdout.trim()
  try {
    const [name, email] = await Promise.all([read('user.name'), read('user.email')])
    if (name && email) return { name, email }
    return null
  } catch {
    // unset (`--get` exits 1), or no git at all
    return null
  }
}
