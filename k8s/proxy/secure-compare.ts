/**
 * Constant-time string comparison for the proxy's control-API bearer check.
 *
 * A pure, dependency-free helper (mirrors transparent.ts / pp2.ts) so it is
 * unit-testable by import — proxy.ts reads env and starts listeners at module
 * load, which makes it untestable directly. proxy.ts pulls this in via a
 * relative import; the Dockerfile copies it alongside the other helpers.
 */

import crypto from 'node:crypto'

/**
 * True iff `a` and `b` are byte-for-byte equal, in time that does not depend
 * on the position of the first differing byte. Guards `timingSafeEqual` (which
 * throws on unequal-length inputs) with a length check first: the length of a
 * bearer secret is not itself secret, so short-circuiting it is fine — the
 * point is not to leak, via the compare's timing, how long a matching prefix
 * an attacker guessed.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
