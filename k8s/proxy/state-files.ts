/**
 * The proxy's on-disk state layer: /data is a hostPath that outlives the pod
 * on purpose, so a replaced proxy comes back knowing every worktree's
 * allowlist instead of failing closed on all of them.
 *
 * Its own module because the registrations file was renamed (`sessions.json`
 * → `worktrees.json`) and reading the wrong name fails SILENTLY — the proxy
 * starts empty and every running worktree loses egress until something
 * re-registers it. proxy.ts listens at import time and cannot be unit-tested,
 * so the fallback lives here where it can be.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

/** Write via a temp file + rename so a crash can never leave a half-file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = filePath + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

/**
 * Read `filePath`, falling back to `legacyPath` when it does not exist yet.
 * Returns null when neither is readable (first boot). The fallback is one
 * upgrade wide: once the proxy persists anything it writes `filePath`, and
 * the legacy name is never written again.
 */
export function readJsonEither(filePath: string, legacyPath: string): unknown {
  for (const p of [filePath, legacyPath]) {
    let raw: string
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch {
      continue
    }
    // A present-but-corrupt file is not a reason to fall back to a stale
    // one: the newer name is authoritative once it exists.
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return null
}
