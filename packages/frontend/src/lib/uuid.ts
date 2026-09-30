/**
 * A RFC 4122 v4 UUID string.
 *
 * `crypto.randomUUID()` exists only in a secure context (https, or http on
 * localhost), so a plain-http remote origin (e.g. a nested yaac reached over
 * a forwarded port) falls back to formatting `crypto.getRandomValues()`
 * bytes, which is random enough for client-minted workspace ids.
 */
export function randomUUID(): string {
  // The DOM lib types randomUUID as always present, hence the cast. `.call`
  // keeps `this === crypto`; some engines throw "illegal invocation" without.
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
