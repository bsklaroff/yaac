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
  return singleQuoted(s)
}

function singleQuoted(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Point a checkout at the main clone's objects, then bring its `origin/*` up
 * to date from the main clone: one shell command, run in the workspace on
 * every launch and driver. `workspaceDir` is where the workspace sees its
 * checkout, and must be shell-safe (driver paths are).
 *
 * The alternates line is the checkout's only path-dependent git state
 * (docs/server-git.md). It is always the main clone's objects dir as the
 * server sees it; pods mount the main clone at that same path. Rewriting it
 * every launch heals a checkout whose data dir moved.
 *
 * Last, a detached `git status` looks up every file once, so a pod's file
 * cache is warm before the agent's or the changes poll's first status
 * (docs/nfs-checkout-performance.md). `--no-optional-locks` keeps it from
 * taking the index lock the agent's own git needs.
 */
export function buildCloneLinkExec(repoGitDir: string, workspaceDir: string): string {
  return `printf '%s\\n' ${singleQuoted(`${repoGitDir}/objects`)} > ${workspaceDir}/.git/objects/info/alternates`
    + ` && { ${buildOriginRefreshExec(repoGitDir, workspaceDir)}; }`
    + ` && { setsid git -C ${workspaceDir} --no-optional-locks status --porcelain </dev/null >/dev/null 2>&1 & }`
}

/**
 * Fast-forward a checkout's `origin/*` from the main clone on disk. The
 * objects are reachable via alternates, so there is no network or
 * credential use. Not forced (an agent-fetched ref ahead of the main clone
 * is kept), no `--prune`, and no FETCH_HEAD (the agent may be between its
 * own fetch and merge). Failures are ignored; the next refresh retries.
 */
export function buildOriginRefreshExec(repoGitDir: string, workspaceDir: string): string {
  return `git -C ${workspaceDir} fetch --quiet --no-tags --no-write-fetch-head `
    + `${singleQuoted(repoGitDir)} 'refs/remotes/origin/*:refs/remotes/origin/*' 2>/dev/null || true`
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
