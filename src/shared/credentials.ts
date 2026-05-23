/**
 * Git credential pattern grammar. Patterns must be host-prefixed. Accepted:
 *   "<host>/*"               — every repo on <host>
 *   "<host>/<path>"          — one specific repo at <path> (any depth, may be
 *                              a single segment or nested like "group/sub/repo")
 *   "<host>/<prefix>/*"      — every repo whose path starts with <prefix>
 *                              (the prefix can itself span multiple segments)
 *
 * Wildcards are only allowed as a trailing path segment. The host segment must
 * be a real hostname (contain a `.`, or be the literal "localhost") and cannot
 * contain a wildcard. Empty segments are rejected.
 *
 * NOTE: keep in sync with podman/proxy-sidecar/proxy.ts — the proxy bundles
 * independently and replicates this logic.
 */

export interface ParsedPattern {
  host: string
  /** 'any' = host wildcard; 'exact' = full path match; 'prefix' = path/... match */
  kind: 'any' | 'exact' | 'prefix'
  /** Empty string when kind === 'any'; otherwise the literal path or prefix. */
  path: string
}

/** Validate a pattern string. Returns true iff `parsePattern` would succeed. */
export function validatePattern(pattern: string): boolean {
  try {
    parsePattern(pattern)
    return true
  } catch {
    return false
  }
}

/** A host segment must contain a `.` or be the literal `localhost`. */
export function isHostSegment(s: string): boolean {
  return s.includes('.') || s === 'localhost'
}

/** Parse a host-prefixed pattern. Throws on unrecognized input. */
export function parsePattern(pattern: string): ParsedPattern {
  if (!pattern || pattern.includes(' ')) {
    throw new Error(`Invalid pattern: "${pattern}"`)
  }
  const parts = pattern.split('/')
  if (parts.length < 2) {
    throw new Error(
      `Pattern must be host-prefixed (e.g. "${pattern}/*"), got "${pattern}"`,
    )
  }
  const host = parts[0]
  if (!host || host.includes('*') || !isHostSegment(host)) {
    throw new Error(
      `Pattern host segment must be a real hostname (e.g. github.com), got "${host}"`,
    )
  }
  const rest = parts.slice(1)
  if (rest.length === 1 && rest[0] === '*') {
    return { host, kind: 'any', path: '' }
  }
  if (rest[rest.length - 1] === '*') {
    const prefixParts = rest.slice(0, -1)
    if (prefixParts.some((p) => !p || p.includes('*'))) {
      throw new Error(
        `Pattern path segments must be literal (no wildcards or empty segments), got "${pattern}"`,
      )
    }
    return { host, kind: 'prefix', path: prefixParts.join('/') }
  }
  if (rest.some((p) => !p || p.includes('*'))) {
    throw new Error(
      `Pattern path may only contain a trailing '*' segment, got "${pattern}"`,
    )
  }
  return { host, kind: 'exact', path: rest.join('/') }
}

/** Does the pattern match this (host, path) pair? `path` is the full repo path. */
export function matchPattern(pattern: string, host: string, path: string): boolean {
  let parsed: ParsedPattern
  try {
    parsed = parsePattern(pattern)
  } catch {
    return false
  }
  if (parsed.host !== host) return false
  if (parsed.kind === 'any') return true
  if (parsed.kind === 'exact') return path === parsed.path
  return path === parsed.path || path.startsWith(parsed.path + '/')
}
