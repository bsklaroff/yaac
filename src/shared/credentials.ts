/**
 * Git credential pattern grammar. Patterns must be host-prefixed. Accepted:
 *   "<host>/*"               — every repo on <host>
 *   "<host>/<owner>/*"       — every repo under <owner> on <host>
 *   "<host>/<owner>/<repo>"  — one specific repo
 *
 * Wildcards are not allowed inside the host or owner segments. The repo
 * segment is either a literal name or "*". Empty segments are rejected.
 *
 * NOTE: keep in sync with podman/proxy-sidecar/proxy.ts — the proxy bundles
 * independently and replicates this logic.
 */

export interface ParsedPattern {
  host: string
  owner: string
  repo: string
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
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid pattern "${pattern}". Use <host>/*, <host>/<owner>/*, or <host>/<owner>/<repo>.`,
    )
  }
  const host = parts[0]
  if (!host || host.includes('*') || !isHostSegment(host)) {
    throw new Error(
      `Pattern host segment must be a real hostname (e.g. github.com), got "${host}"`,
    )
  }
  if (parts.length === 2) {
    if (parts[1] !== '*') {
      throw new Error(
        `Two-segment pattern "${pattern}" must end in '*'. `
        + 'For a specific repo use <host>/<owner>/<repo>.',
      )
    }
    return { host, owner: '*', repo: '*' }
  }
  const owner = parts[1]
  const repo = parts[2]
  if (!owner || owner.includes('*')) {
    throw new Error(`Pattern owner segment must be literal, got "${owner}"`)
  }
  if (!repo || (repo.includes('*') && repo !== '*')) {
    throw new Error(`Pattern repo segment must be '*' or a literal name, got "${repo}"`)
  }
  return { host, owner, repo }
}

/** Does the pattern match this (host, owner, repo) triple? */
export function matchPattern(pattern: string, host: string, owner: string, repo: string): boolean {
  let parsed: ParsedPattern
  try {
    parsed = parsePattern(pattern)
  } catch {
    return false
  }
  if (parsed.host !== host) return false
  if (parsed.owner !== '*' && parsed.owner !== owner) return false
  if (parsed.repo !== '*' && parsed.repo !== repo) return false
  return true
}
