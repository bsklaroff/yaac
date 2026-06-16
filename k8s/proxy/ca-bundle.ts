/**
 * Combined-trust-bundle helpers for the proxy's /ca-bundle.pem endpoint.
 *
 * Nested containers (in-pod podman) run tools that ship their own CA bundle
 * and ignore SSL_CERT_FILE/SSL_CERT_DIR — curl, Python requests, cargo's
 * libcurl, git's libcurl. Those honor only a single-file pointer
 * (CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / CARGO_HTTP_CAINFO / GIT_SSL_CAINFO)
 * and that pointer REPLACES the whole trust set. Pointing it at the lone
 * proxy CA makes the tool trust the MITM cert but reject the REAL cert of
 * every host the proxy tunnels (npm, PyPI, crates.io, …). The fix is to
 * point those vars at a single file that is the UNION
 * `{public roots} ∪ {proxy CA}` — a superset, so "replace" semantics become
 * correct. See plans/nested-ca-combined-bundle.md.
 */

/** Path to the image's public roots (provided by the ca-certificates pkg). */
export const SYSTEM_ROOTS_PATH = '/etc/ssl/certs/ca-certificates.crt'

/**
 * Concatenate the public roots with the proxy MITM CA into one PEM. Both
 * inputs are preserved verbatim; a newline is inserted between them when the
 * roots block does not already end with one, so the boundary between the
 * last root and the CA's `-----BEGIN CERTIFICATE-----` is never lost.
 * Pure (no I/O) so it is unit-testable.
 */
export function combineCaBundle(rootsPem: string, caPem: string): string {
  const roots = rootsPem ?? ''
  const sep = roots.length === 0 || roots.endsWith('\n') ? '' : '\n'
  return `${roots}${sep}${caPem}`
}
