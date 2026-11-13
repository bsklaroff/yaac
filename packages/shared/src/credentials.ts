/**
 * Whether a git host is github.com, the one host whose https repos are
 * offered to `gh` as `GH_TOKEN` (GitHub Enterprise is not supported). Which
 * API hosts the proxy sends that token to is `ghApiHostsForGitHost` in
 * k8s/proxy/repo-grants.ts.
 */
export function isGitHubHost(host: string): boolean {
  return host === 'github.com'
}
