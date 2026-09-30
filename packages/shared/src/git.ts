import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { env } from '#env'

const execFileAsync = promisify(execFile)

/**
 * ssh options that route through Tor when `YAAC_USE_TOR` is set. ssh
 * ignores proxy env vars, so this uses a ProxyCommand with OpenBSD `nc`,
 * which passes the hostname to the SOCKS5 proxy so DNS resolves at the Tor
 * exit. Requires OpenBSD `nc` (macOS has it; Dockerfile.server installs
 * it). `ssh-keyscan` cannot take these options (see fetchKnownHostsEntry
 * in #domain/git).
 */
export function torSshOpts(): string[] {
  if (!env.useTor) return []
  const url = new URL(env.torSocksUrl)
  const host = url.hostname
  const port = parseInt(url.port || '9050', 10)
  return ['-o', `ProxyCommand=nc -X 5 -x ${host}:${port} %h %p`]
}

/**
 * Join ssh argv into a GIT_SSH_COMMAND string. git splits that value with
 * shell rules, so args containing spaces or shell characters (such as a
 * ProxyCommand) are single-quoted.
 */
export function formatSshCommand(args: string[]): string {
  return args.map(shellQuoteArg).join(' ')
}

function shellQuoteArg(s: string): string {
  if (s !== '' && !/[\s'"\\$`*?|&;<>()#]/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * The user's global git name and email, or `null` if either is unset or
 * `git` fails.
 */
export async function getGitUserConfig(): Promise<{ name: string; email: string } | null> {
  const read = async (key: string): Promise<string> =>
    (await execFileAsync('git', ['config', '--global', '--get', key])).stdout.trim()
  try {
    const [name, email] = await Promise.all([read('user.name'), read('user.email')])
    if (name && email) return { name, email }
    return null
  } catch {
    return null
  }
}
