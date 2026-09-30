/**
 * Constant-time string comparison for the proxy's control-API bearer check.
 * Kept in its own dependency-free module so tests can import it; proxy.ts
 * starts listeners at load time.
 */

import crypto from 'node:crypto'

/**
 * True iff `a` and `b` are byte-for-byte equal, in time that does not reveal
 * how long a matching prefix is. The length check runs first because
 * `timingSafeEqual` throws on unequal lengths; a secret's length is not
 * itself secret.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
