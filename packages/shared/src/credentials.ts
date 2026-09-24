/**
 * Map a git host to the API host the GitHub CLI (`gh`) authenticates against,
 * or null for non-GitHub hosts (`gh` only talks to GitHub). Public GitHub's
 * REST + GraphQL API lives on `api.github.com` while the git remote is
 * `github.com`. GitHub Enterprise (same-host `/api/v3`) is not auto-wired yet.
 *
 * NOTE: keep in sync with k8s/proxy/proxy.ts — the proxy bundles independently
 * and replicates this mapping to decide which host to MITM for gh token swaps.
 */
export function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}
