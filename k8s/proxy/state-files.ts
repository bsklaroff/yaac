/**
 * The proxy's on-disk state layer: /data is a hostPath that outlives the pod
 * on purpose, so a replaced proxy comes back knowing every worktree's
 * allowlist instead of failing closed on all of them.
 *
 * Its own module because proxy.ts listens at import time and cannot be
 * unit-tested, while this half decides whether a redeployed proxy recovers
 * its registrations — a read that goes wrong here fails SILENTLY, with the
 * proxy starting empty and every running worktree losing egress until
 * something re-registers it.
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
 * Read `filePath`, or null when it is missing (first boot) or unparseable.
 * A corrupt file reads as absent rather than throwing: the proxy comes up
 * with no registrations, which is the same state it recovers from by being
 * re-registered.
 */
export function readJsonOrNull(filePath: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Give a persisted registration's bare `secretRef`s their project scope.
 *
 * A ref used to be the variable NAME alone, resolved against one flat map
 * shared by every project; it is `<projectSlug>/<NAME>` now. A registration
 * written before that — reloaded here after a pod replacement — therefore
 * names refs the server will never push again, and its injections would stop
 * resolving silently until the worktree was recreated.
 *
 * The rewrite is exact rather than a guess: a registration carries the
 * project it belongs to, and a bare ref in it could only ever have meant that
 * project's secret of that name. Doing it on the way IN is also what keeps
 * the fix from reopening what the scope closed — nothing resolves a bare ref
 * at injection time.
 *
 * Lives here rather than in proxy.ts for this module's own reason: a read
 * that goes wrong fails silently, with the proxy running and the credential
 * simply not arriving.
 */
export function scopeLegacySecretRefs<
  R extends { injections: Array<{ secretRef?: string }> },
>(rules: R[], projectSlug: string | undefined): R[] {
  if (projectSlug === undefined || projectSlug === '') return rules
  return rules.map((rule) => ({
    ...rule,
    injections: rule.injections.map((inj) =>
      inj.secretRef !== undefined && !inj.secretRef.includes('/')
        ? { ...inj, secretRef: `${projectSlug}/${inj.secretRef}` }
        : inj),
  }))
}
