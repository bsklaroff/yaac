import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { KubeConfig } from '@kubernetes/client-node'
import {
  PodWorkspaceIndex,
  _resetInClusterClientForTests,
  inClusterClient,
  podWorkspaceId,
} from 'yaac-proxy-sidecar/pod-watch'
import type { WatchedPod } from 'yaac-proxy-sidecar/pod-watch'

function pod(ip: string | undefined, sid: string | undefined): WatchedPod {
  return {
    metadata: sid === undefined ? {} : { labels: { 'yaac.workspace-id': sid } },
    status: ip === undefined ? {} : { podIP: ip },
  }
}

describe('podWorkspaceId', () => {
  it('returns the workspace id when the pod has an IP and the label', () => {
    expect(podWorkspaceId(pod('10.0.0.1', 'sess-a'))).toBe('sess-a')
  })

  it('returns null without an IP or without the label', () => {
    expect(podWorkspaceId(pod(undefined, 'sess-a'))).toBeNull()
    expect(podWorkspaceId(pod('10.0.0.1', undefined))).toBeNull()
  })
})

describe('PodWorkspaceIndex', () => {
  it('upserts on ADDED/MODIFIED and resolves by IP', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-a')
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', 'sess-b') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-b')
  })

  it('evicts on DELETED so a reused IP cannot be misattributed', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    // The IP is now free to be a different workspace.
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-c') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-c')
  })

  it('ignores a pod with no IP and evicts one that lost its workspace label', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod(undefined, 'sess-a') })
    expect(idx.size).toBe(0)
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', undefined) })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
  })

  it('replaceAll rebuilds the index and evicts pods that vanished', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'ADDED', object: pod('10.0.0.2', 'sess-b') })
    // A re-list that no longer contains 10.0.0.1 drops it.
    idx.replaceAll([pod('10.0.0.2', 'sess-b'), pod('10.0.0.3', 'sess-c')])
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    expect(idx.resolve('10.0.0.2')).toBe('sess-b')
    expect(idx.resolve('10.0.0.3')).toBe('sess-c')
  })

  it('set() seeds an entry (the cache-miss fallback path)', () => {
    const idx = new PodWorkspaceIndex()
    idx.set('10.0.0.9', 'sess-z')
    expect(idx.resolve('10.0.0.9')).toBe('sess-z')
    expect(idx.resolveIp('sess-z')).toBe('10.0.0.9')
  })

  it('resolveIp reverse-resolves the workspace to its pod IP (the relay path)', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.1')
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBeUndefined()
  })

  it('a replaced pod repoints the workspace; the old pod\'s late DELETED does not evict it', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    // Replacement pod appears first (new IP)…
    idx.apply({ type: 'ADDED', object: pod('10.0.0.2', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.2')
    // …then the old pod's DELETED arrives late: the reverse entry must keep
    // pointing at the live pod.
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.2')
  })

  it('replaceAll rebuilds the reverse index too', () => {
    const idx = new PodWorkspaceIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.replaceAll([pod('10.0.0.2', 'sess-b')])
    expect(idx.resolveIp('sess-a')).toBeUndefined()
    expect(idx.resolveIp('sess-b')).toBe('10.0.0.2')
  })
})

describe('inClusterClient', () => {
  const config = (namespace?: string): KubeConfig => {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'c', server: 'https://10.96.0.1:443', skipTLSVerify: true }],
      users: [{ name: 'u' }],
      contexts: [{ name: 'ctx', cluster: 'c', user: 'u', ...(namespace ? { namespace } : {}) }],
      currentContext: 'ctx',
    })
    return kubeConfig
  }

  beforeEach(() => { _resetInClusterClientForTests() })
  afterEach(() => { _resetInClusterClientForTests() })

  it('exposes the API client and the namespace it serves', () => {
    const client = inClusterClient(config('yaac'))
    expect(client.namespace).toBe('yaac')
    expect(typeof client.core.listNamespacedPod).toBe('function')
  })

  it('memoizes, so the informer and the fallbacks share one credential source', () => {
    const first = inClusterClient(config('yaac'))
    expect(inClusterClient(config('other'))).toBe(first)
  })

  it('_resetInClusterClientForTests drops the memo', () => {
    const first = inClusterClient(config('yaac'))
    _resetInClusterClientForTests()
    expect(inClusterClient(config('other'))).not.toBe(first)
  })

  it('refuses a config with no namespace rather than guessing one', () => {
    // Outside a pod `loadFromCluster` leaves the namespace unset; guessing
    // one would silently misattribute traffic.
    expect(() => inClusterClient(config())).toThrow(/no in-cluster namespace/)
  })
})
