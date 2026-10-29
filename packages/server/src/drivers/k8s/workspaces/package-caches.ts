/**
 * The install's package caches as a workspace meets them
 * (docs/workspace-storage.md, "Package installs"): who may use each, and how
 * a live pod is re-pointed. The pod's label decides whether it can reach a
 * cache; `workspace-bin/yaac-package-cache` writes the client config that
 * makes it use one.
 */
import { CRATES_CACHE, NPM_CACHE, type PackageCache } from '#drivers/k8s/cluster'
import { execFileAsync, k8sNamespace } from '#drivers/k8s/substrate'
import { hostMatchesPattern } from '#lib/allowed-hosts'
import type { SecretProxyRule, YaacConfig } from '@yaac/shared/types'

/** A cache, with what decides and carries a workspace's use of it. */
export interface WorkspaceCache extends PackageCache {
  /** The project setting that opts a project out with `false`. */
  setting: 'npmCache' | 'cratesCache'
  /** The hosts the cache stands in for. */
  hosts: string[]
  /** The client `yaac-package-cache` configures. */
  client: 'npm' | 'cargo'
  /** The env var the init script reads the cache's URL from. */
  env: string
}

export const WORKSPACE_CACHES: WorkspaceCache[] = [
  { ...NPM_CACHE, setting: 'npmCache', hosts: ['registry.npmjs.org'], client: 'npm', env: 'YAAC_NPM_REGISTRY' },
  {
    ...CRATES_CACHE,
    setting: 'cratesCache',
    hosts: ['crates.io', 'index.crates.io', 'static.crates.io'],
    client: 'cargo',
    env: 'YAAC_CRATES_CACHE',
  },
]

/**
 * Whether a workspace may use `cache`. Not when its project turns the cache
 * off; not when its allowlist leaves out one of the cache's hosts (the cache
 * fetches outside the egress proxy); and not when the project authenticates
 * to one of them through a proxied secret (the cache fetches anonymously, so
 * private packages would break, and cargo refuses to publish to a replaced
 * crates.io). A token in the project's own client config is the project's
 * concern.
 */
export function cacheApplies(
  cache: WorkspaceCache,
  config: YaacConfig,
  allowedHosts: string[],
  secretRules: Record<string, SecretProxyRule>,
): boolean {
  if (config[cache.setting] === false) return false
  const allowed = (allowedHosts.length === 1 && allowedHosts[0] === '*')
    || cache.hosts.every((host) => allowedHosts.some((pattern) => hostMatchesPattern(host, pattern)))
  const authenticated = Object.values(secretRules).some((rule) =>
    rule.hosts.some((pattern) => cache.hosts.some((host) => hostMatchesPattern(host, pattern))))
  return allowed && !authenticated
}

/** Point a live pod's client at `url`, or at no cache, as its init did. */
export async function writeCacheConfig(podName: string, cache: WorkspaceCache, url: string | null): Promise<void> {
  await execFileAsync('kubectl', [
    'exec', '-n', k8sNamespace(), podName, '--', 'yaac-package-cache', cache.client, url ?? '',
  ])
}
