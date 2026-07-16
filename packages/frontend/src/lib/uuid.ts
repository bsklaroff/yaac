/**
 * A RFC 4122 v4 UUID string.
 *
 * Prefers the native `crypto.randomUUID()`, but that method is only exposed
 * in a **secure context** (https, or http on localhost) — so on a plain-http
 * non-localhost origin (e.g. a nested yaac reached over a Tailscale-forwarded
 * port) it is `undefined` and calling it throws `crypto.randomUUID is not a
 * function`. `crypto.getRandomValues()` has no such restriction, so fall back
 * to it and format the 16 random bytes ourselves (version nibble → 4, variant
 * nibble → 10xx). The webapp uses these only as client-minted session ids, so
 * the fallback's randomness is more than sufficient.
 */
export function randomUUID(): string {
  // Typed as optional so the guard is meaningful (the DOM lib types it as
  // always-present); `.call` keeps `this === crypto`, else engines that
  // brand-check throw "illegal invocation" on a detached reference.
  const native = (crypto as { randomUUID?: () => string }).randomUUID
  if (typeof native === 'function') return native.call(crypto)
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes, (b, i) => {
    const v = i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b
    return v.toString(16).padStart(2, '0')
  })
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-`
    + `${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-`
    + `${hex.slice(10, 16).join('')}`
  )
}
