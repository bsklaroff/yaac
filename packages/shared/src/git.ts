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
 * The push URL of a remote a workspace only fetches: a path that is not a
 * repository on any machine (`/dev/null` is no directory), so a push fails
 * at once and git's error quotes it (docs/repo-forks.md "Read-only repos").
 */
export const NO_PUSH_URL = '/dev/null/yaac: workspaces do not push to this remote'

/** A checkout's remotes, as its repo's rows say (docs/repo-forks.md). */
export interface CheckoutRemotes {
  /** `origin`'s URL, the repo row's. */
  url: string
  /** Whether workspaces only read the repo, so `origin` takes `NO_PUSH_URL`
   *  as its push URL. */
  readOnly: boolean
  /** A fork's upstream URL, a remote that can only be fetched; absent for a
   *  repo with none, or one the checkout's project owner may not use. */
  upstream?: string
}

/**
 * Point a checkout at the main clone's objects, set its remotes to match
 * the rows, then bring its `origin/*` (and `upstream/*`) up to date from
 * the main clone: one shell command, run in the workspace when a launch
 * reuses a checkout. `workspaceDir` is where the workspace sees its
 * checkout, and must be shell-safe (driver paths are). A checkout the
 * launch just created already has all of it.
 *
 * The alternates line is the checkout's only path-dependent git state
 * (docs/server-git.md). It is always the main clone's objects dir as the
 * server sees it; pods mount the main clone at that same path. Rewriting it
 * on every reuse heals a checkout whose data dir moved. `origin` is yaac's
 * remote in a checkout, so its URL always becomes the row's, which follows
 * a repo through every move; a user who wants another remote adds one under
 * another name.
 */
export function buildCloneLinkExec(repoGitDir: string, workspaceDir: string, remotes: CheckoutRemotes): string {
  const git = `git -C ${workspaceDir}`
  const noPush = singleQuoted(NO_PUSH_URL)
  return [
    `printf '%s\\n' ${singleQuoted(`${repoGitDir}/objects`)} > ${workspaceDir}/.git/objects/info/alternates`,
    `${git} config remote.origin.url ${singleQuoted(remotes.url)}`,
    remotes.readOnly
      ? `${git} config --replace-all remote.origin.pushurl ${noPush}`
      : `{ ${git} config --unset-all remote.origin.pushurl 2>/dev/null; true; }`,
    remotes.upstream !== undefined
      ? `${git} config --replace-all remote.upstream.url ${singleQuoted(remotes.upstream)}`
        + ` && ${git} config --replace-all remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'`
        + ` && ${git} config --replace-all remote.upstream.pushurl ${noPush}`
      : `{ ${git} remote remove upstream 2>/dev/null; true; }`,
    buildOriginRefreshExec(repoGitDir, workspaceDir),
  ].join(' && ')
}

/**
 * A detached `git status` that looks up every file once, so a pod's file
 * cache is warm before the agent's or the changes poll's first status
 * (docs/nfs-checkout-performance.md). `--no-optional-locks` keeps it from
 * taking the index lock the agent's own git needs.
 */
export function buildStatusWarmupExec(workspaceDir: string): string {
  return `{ setsid git -C ${workspaceDir} --no-optional-locks status --porcelain </dev/null >/dev/null 2>&1 & }`
}

/**
 * Bring a checkout's `origin/*`, and a fork's `upstream/*` where the
 * checkout has that remote, up to date from the main clone on disk. The
 * objects are reachable via alternates, so there is no network or
 * credential use. A branch is fast-forwarded, so a ref an agent's own
 * fetch moved ahead of the main clone is kept, and set outright only where
 * neither tip contains the other: the branch was rewritten, not fetched
 * ahead (docs/server-git.md "Keeping `origin/*` fresh"). No `--prune`, and
 * no FETCH_HEAD (the agent may be between its own fetch and merge).
 * Failures are ignored; the next refresh retries.
 */
export function buildOriginRefreshExec(repoGitDir: string, workspaceDir: string): string {
  const git = `git -C ${workspaceDir}`
  const main = singleQuoted(repoGitDir)
  const copy = (remote: string): string =>
    `${git} fetch --quiet --no-tags --no-write-fetch-head ${main} 'refs/remotes/${remote}/*:refs/remotes/${remote}/*' 2>/dev/null`
  return `{ ${copy('origin')}; ! ${git} config remote.upstream.url >/dev/null || ${copy('upstream')}; `
    + `{ ${git} ls-remote ${main} 'refs/remotes/*'; echo; `
    + `${git} for-each-ref --format='%(objectname)%09%(refname)' refs/remotes/origin refs/remotes/upstream; } 2>/dev/null`
    + ` | awk -F'\\t' 'NF < 2 { mine = 1; next } !mine { tip[$2] = $1; next }`
    + ` $2 !~ /\\/HEAD$/ && ($2 in tip) && tip[$2] != $1 { print tip[$2], $1, $2 }'`
    + ` | while read -r new old ref; do ${git} merge-base --is-ancestor "$new" "$old" 2>/dev/null`
    + ` || ${git} update-ref "$ref" "$new" "$old"; done; true; }`
}

/**
 * Whether `name` could name a branch on origin under `git check-ref-format
 * --branch`'s rules, so one that never could is refused without fetching.
 * `HEAD` is refused too: `origin/HEAD` names no branch of its own.
 */
export function isBranchName(name: string): boolean {
  return /^(?![-./])[^\p{Cc} ~^:?*[\\]+$/u.test(name)
    && !/\.\.|@\{|\/[./]|\.lock(?:\/|$)|[/.]$/.test(name)
    && name !== '@' && name !== 'HEAD'
}

/** Quote and escape a git-config value or subsection name so it reads back
 *  verbatim and cannot break the file. */
export function gitConfigValue(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`
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
