import { getActiveClusterCache } from '#drivers/k8s/substrate'
import type { GitAuthFailure, RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Synchronous reads of what the proxy reports, taken from the
 * `ClusterCache`'s watched copies of the objects it writes: blocked hosts
 * and git auth failures in `yaac-proxy-state`, and captured OAuth rotations
 * in `yaac-proxy-refreshed`. Changes to either are handled in
 * `k8s/lifecycle.ts`. Outside a server no cache runs, so every read is
 * empty.
 */

/** The blocked hostnames the proxy has recorded for one workspace. */
export function readBlockedHosts(workspaceId: string): string[] {
  return getActiveClusterCache()?.proxyRecords().blockedHosts[workspaceId] ?? []
}

/** Every project's git auth failures. */
export function readAllGitAuthFailures(): Record<string, GitAuthFailure[]> {
  return getActiveClusterCache()?.proxyRecords().gitAuthFailures ?? {}
}

/** The git auth failures the proxy has recorded for one project. */
export function readGitAuthFailures(projectSlug: string): GitAuthFailure[] {
  return readAllGitAuthFailures()[projectSlug] ?? []
}

/** The rotations the proxy captured that the host store may not hold yet. */
export function refreshedCredentials(): RefreshedToolCredentials {
  return getActiveClusterCache()?.refreshedCredentials() ?? {}
}
