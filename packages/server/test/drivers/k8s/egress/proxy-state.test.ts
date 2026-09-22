import { afterEach, describe, expect, it } from 'vitest'
import {
  readAllGitAuthFailures,
  readBlockedHosts,
  readGitAuthFailures,
  refreshedCredentials,
} from '#drivers/k8s/egress/proxy-state'
import { setActiveClusterCache, type ClusterCache } from '#drivers/k8s/substrate'
import type { ProxyState } from '#drivers/k8s/substrate/proxy-objects'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Synchronous reads of the `ClusterCache`'s view of the proxy's two output
 * objects. The cache is the boundary — what the informer put in it is what
 * these answer — so a stub stands in for it; the mapping from raw objects
 * is the cache's own, tested with it.
 */

function cacheOf(state: ProxyState, refreshed: RefreshedToolCredentials = {}): ClusterCache {
  return {
    proxyRecords: () => state,
    refreshedCredentials: () => refreshed,
  } as unknown as ClusterCache
}

afterEach(() => { setActiveClusterCache(null) })

describe('readBlockedHosts', () => {
  it('answers one worktree’s record, and nothing outside a server', () => {
    expect(readBlockedHosts('w1')).toEqual([])
    setActiveClusterCache(cacheOf({ blockedHosts: { w1: ['evil.example.com'] }, gitAuthFailures: {} }))
    expect(readBlockedHosts('w1')).toEqual(['evil.example.com'])
    expect(readBlockedHosts('w2')).toEqual([])
  })
})

describe('readGitAuthFailures', () => {
  it('answers one project’s failures', () => {
    const failure = { host: 'github.com', status: 401, atMs: 5 }
    setActiveClusterCache(cacheOf({ blockedHosts: {}, gitAuthFailures: { demo: [failure] } }))
    expect(readGitAuthFailures('demo')).toEqual([failure])
    expect(readGitAuthFailures('other')).toEqual([])
  })
})

describe('readAllGitAuthFailures', () => {
  it('answers every project’s failures, and empty outside a server', () => {
    expect(readAllGitAuthFailures()).toEqual({})
    const failures = { demo: [{ host: 'github.com', status: 403, atMs: 1 }] }
    setActiveClusterCache(cacheOf({ blockedHosts: {}, gitAuthFailures: failures }))
    expect(readAllGitAuthFailures()).toEqual(failures)
  })
})

describe('refreshedCredentials', () => {
  it('answers the captured rotations, and none outside a server', () => {
    expect(refreshedCredentials()).toEqual({})
    const claude = { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: [] }
    setActiveClusterCache(cacheOf({ blockedHosts: {}, gitAuthFailures: {} }, { claude }))
    expect(refreshedCredentials()).toEqual({ claude })
  })
})
