import { getActiveClusterCache } from '#drivers/k8s/substrate'
import type { GitAuthFailure, RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * What the proxy reports, read off the `ClusterCache`'s watch-fed view of
 * the objects it writes: the blocked-host and git-auth-failure records in
 * `yaac-proxy-state`, and the OAuth rotations it captured in
 * `yaac-proxy-refreshed`. Synchronous reads of a cache the informer keeps
 * current; the delta on either is what notifies the snapshot or dirties
 * the pass (`k8s/lifecycle.ts`). Empty outside a server, where no cache
 * runs — exactly what a runtime that mediates no egress answers.
 */

/** The blocked hostnames the proxy has recorded for one worktree. */
export function readBlockedHosts(worktreeId: string): string[] {
  return getActiveClusterCache()?.proxyRecords().blockedHosts[worktreeId] ?? []
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
