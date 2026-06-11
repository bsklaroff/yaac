import simpleGit from 'simple-git'

/**
 * Parses YAAC_USE_TOR with permissive truthy semantics: unset, empty,
 * "0", and "false" (case-insensitive) are off; everything else is on.
 *
 * Lives in shared so both the daemon (which gates host-side git ops on
 * it) and CLI commands (which need it to build ssh opts) can use it
 * without the latter pulling on @/lib/git, which the lint boundary forbids.
 */
export function isTorEnabled(): boolean {
  const raw = process.env.YAAC_USE_TOR
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  if (v === '' || v === '0' || v === 'false') return false
  return true
}

/**
 * ssh does not honor ALL_PROXY / HTTPS_PROXY, so Tor routing for ssh has
 * to go through `-o ProxyCommand=...`. OpenBSD `nc -X 5 -x` passes the
 * destination hostname unchanged to the SOCKS5 proxy, so Tor resolves DNS
 * at its exit (no local-DNS leak). `netcat-openbsd` is on every
 * Linux/macOS we target.
 *
 * Note: these opts must NOT be passed to `ssh-keyscan` — its `-O` flag
 * only accepts `hashalg`, not ProxyCommand. For host-key fetches under
 * Tor, drive `ssh` instead (see fetchKnownHostsEntry in auth-update.ts).
 */
export function torSshOpts(): string[] {
  if (!isTorEnabled()) return []
  const url = new URL(process.env.YAAC_HOST_TOR_SOCKS_URL ?? 'socks5h://127.0.0.1:9050')
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
 * and forwards the resolved pair to the daemon) and the daemon
 * (which falls back to the global config during non-interactive
 * session creation) need it.
 */
export async function getGitUserConfig(): Promise<{ name: string; email: string } | null> {
  try {
    const git = simpleGit()
    const name = (await git.getConfig('user.name', 'global')).value
    const email = (await git.getConfig('user.email', 'global')).value
    if (name && email) return { name, email }
    return null
  } catch {
    return null
  }
}
