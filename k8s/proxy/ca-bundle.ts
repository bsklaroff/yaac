/**
 * Builds the `ca-bundle.pem` the proxy writes beside its CA into the
 * `yaac-proxy-ca` Secret: the public roots plus the proxy's MITM CA.
 *
 * Tools in nested containers (curl, Python requests, cargo, git) take a
 * single CA file (CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, …) that replaces their
 * whole trust set. Pointing them at the proxy CA alone would break every
 * host the proxy tunnels without MITM, so they get this combined file.
 * See docs/nested-containers.md.
 */

/** Path to the image's public roots (provided by the ca-certificates pkg). */
export const SYSTEM_ROOTS_PATH = '/etc/ssl/certs/ca-certificates.crt'

/**
 * Concatenate the public roots and the proxy CA into one PEM, adding a
 * newline between them if the roots do not end with one.
 */
export function combineCaBundle(rootsPem: string, caPem: string): string {
  const roots = rootsPem ?? ''
  const sep = roots.length === 0 || roots.endsWith('\n') ? '' : '\n'
  return `${roots}${sep}${caPem}`
}
