/**
 * Validate a token pattern. Valid forms:
 * - "*" (catch-all)
 * - "<owner>/*" (all repos for an owner)
 * - "<owner>/<repo>" (specific repo)
 */
export function validatePattern(pattern: string): boolean {
  if (pattern === '*') return true
  const parts = pattern.split('/')
  if (parts.length !== 2) return false
  const [owner, repo] = parts
  if (!owner || owner === '*') return false
  if (repo === '') return false
  // owner must be a literal name (no wildcards)
  if (owner.includes('*')) return false
  // repo must be either "*" or a literal name
  if (repo.includes('*') && repo !== '*') return false
  return true
}
