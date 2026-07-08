/**
 * Parse a NUL-delimited environment dump — as emitted by `env -0` run inside
 * the user's login shell — into a plain record. NUL delimiting (rather than
 * newline) keeps values that legitimately contain newlines intact. Blank and
 * keyless entries are skipped.
 *
 * Used to hydrate the packaged app's PATH: an Electron app launched from
 * Finder inherits a minimal PATH, but the daemon shells out to
 * kubectl/podman/kind/tmux/brew, so we read the real PATH from the login
 * shell before spawning it.
 */
export function parseNulEnv(dump: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of dump.split('\0')) {
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}
