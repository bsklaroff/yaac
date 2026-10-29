/**
 * The package caches' shared barrel function: the URL a workspace create
 * reads to decide whether a client fetches through a cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { CRATES_CACHE, NPM_CACHE, servingCacheUrl } from '#drivers/k8s/cluster'

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('servingCacheUrl', () => {
  // Neither pnpm nor cargo falls back from the registry it is given, so a
  // workspace pointed at a down cache fails every install. The URL is given
  // only while a pod is ready, and is checked on every call.
  it('names a cache\'s Service only while one of its own pods is ready behind it', async () => {
    const slice = (name: string, service: string, ready: boolean) => ({
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: { name, namespace: 'test-ns', labels: { 'kubernetes.io/service-name': service } },
      endpoints: [{ conditions: { ready } }],
    })
    const npm = 'http://yaac-npm-cache.test-ns.svc.cluster.local:4873/'

    await expect(servingCacheUrl(NPM_CACHE)).resolves.toBeNull()
    // Another Service's ready endpoint says nothing about the cache.
    fakeCluster.seed(slice('other', 'yaac-proxy', true), slice('cache-a', 'yaac-npm-cache', false))
    await expect(servingCacheUrl(NPM_CACHE)).resolves.toBeNull()
    fakeCluster.seed(slice('cache-a', 'yaac-npm-cache', true))
    await expect(servingCacheUrl(NPM_CACHE)).resolves.toBe(npm)
    // Nor does the other cache's.
    await expect(servingCacheUrl(CRATES_CACHE)).resolves.toBeNull()
    fakeCluster.seed(slice('crates-a', 'yaac-crates-cache', true))
    await expect(servingCacheUrl(CRATES_CACHE)).resolves.toBe('http://yaac-crates-cache.test-ns.svc.cluster.local:4875/')
    fakeCluster.seed(slice('cache-a', 'yaac-npm-cache', false))
    await expect(servingCacheUrl(NPM_CACHE)).resolves.toBeNull()
  })
})
