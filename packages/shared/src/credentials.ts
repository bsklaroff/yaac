/**
 * The API host `gh` authenticates against for a git host, or null for
 * anything but github.com (GitHub Enterprise is not supported).
 *
 * The proxy (k8s/proxy) has its own copy of this mapping; keep them in sync.
 */
export function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}
