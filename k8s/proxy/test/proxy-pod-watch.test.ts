import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { KubeConfig } from '@kubernetes/client-node'
import {
  PodWorktreeIndex,
  _resetInClusterClientForTests,
  inClusterClient,
  parseVclusterAttribution,
  podWorktreeId,
} from 'yaac-proxy-sidecar/pod-watch'
import type { WatchedPod } from 'yaac-proxy-sidecar/pod-watch'

function pod(ip: string | undefined, sid: string | undefined): WatchedPod {
  return {
    metadata: sid === undefined ? {} : { labels: { 'yaac.session-id': sid } },
    status: ip === undefined ? {} : { podIP: ip },
  }
}

describe('podWorktreeId', () => {
  it('returns the worktree id when the pod has an IP and the label', () => {
    expect(podWorktreeId(pod('10.0.0.1', 'sess-a'))).toBe('sess-a')
  })

  it('returns null without an IP or without the label', () => {
    expect(podWorktreeId(pod(undefined, 'sess-a'))).toBeNull()
    expect(podWorktreeId(pod('10.0.0.1', undefined))).toBeNull()
  })
})

describe('PodWorktreeIndex', () => {
  it('upserts on ADDED/MODIFIED and resolves by IP', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-a')
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', 'sess-b') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-b')
  })

  it('evicts on DELETED so a reused IP cannot be misattributed', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    // The IP is now free to be a different worktree.
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-c') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-c')
  })

  it('ignores a pod with no IP and evicts one that lost its worktree label', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod(undefined, 'sess-a') })
    expect(idx.size).toBe(0)
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', undefined) })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
  })

  it('replaceAll rebuilds the index and evicts pods that vanished', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'ADDED', object: pod('10.0.0.2', 'sess-b') })
    // A re-list that no longer contains 10.0.0.1 drops it.
    idx.replaceAll([pod('10.0.0.2', 'sess-b'), pod('10.0.0.3', 'sess-c')])
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    expect(idx.resolve('10.0.0.2')).toBe('sess-b')
    expect(idx.resolve('10.0.0.3')).toBe('sess-c')
  })

  it('set() seeds an entry (the cache-miss fallback path)', () => {
    const idx = new PodWorktreeIndex()
    idx.set('10.0.0.9', 'sess-z')
    expect(idx.resolve('10.0.0.9')).toBe('sess-z')
    expect(idx.resolveIp('sess-z')).toBe('10.0.0.9')
  })

  it('resolveIp reverse-resolves the worktree to its pod IP (the relay path)', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.1')
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBeUndefined()
  })

  it('a replaced pod repoints the worktree; the old pod\'s late DELETED does not evict it', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    // Replacement pod appears first (new IP)…
    idx.apply({ type: 'ADDED', object: pod('10.0.0.2', 'sess-a') })
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.2')
    // …then the OLD pod's DELETED arrives late: byIp evicts the old IP but
    // the reverse entry must keep pointing at the live pod.
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    expect(idx.resolveIp('sess-a')).toBe('10.0.0.2')
  })

  it('replaceAll rebuilds the reverse index too', () => {
    const idx = new PodWorktreeIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.replaceAll([pod('10.0.0.2', 'sess-b')])
    expect(idx.resolveIp('sess-a')).toBeUndefined()
    expect(idx.resolveIp('sess-b')).toBe('10.0.0.2')
  })
})

describe('parseVclusterAttribution', () => {
  it('parses a flat podIP→worktreeId map', () => {
    const m = parseVclusterAttribution('{"10.0.0.1":"sess-a","10.0.0.2":"sess-b"}')
    expect(m).not.toBeNull()
    expect(m!.get('10.0.0.1')).toBe('sess-a')
    expect(m!.get('10.0.0.2')).toBe('sess-b')
    expect(m!.size).toBe(2)
  })

  it('accepts an empty object (full-replace clear)', () => {
    const m = parseVclusterAttribution('{}')
    expect(m).not.toBeNull()
    expect(m!.size).toBe(0)
  })

  it('returns null for malformed JSON, arrays, or non-string values', () => {
    expect(parseVclusterAttribution('not json')).toBeNull()
    expect(parseVclusterAttribution('[]')).toBeNull()
    expect(parseVclusterAttribution('null')).toBeNull()
    expect(parseVclusterAttribution('{"10.0.0.1":123}')).toBeNull()
    expect(parseVclusterAttribution('{"10.0.0.1":""}')).toBeNull()
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
    // Outside a pod there is no ServiceAccount mount, so `loadFromCluster`
    // leaves the namespace unset — resolving worktrees against the wrong
    // namespace would silently mis-attribute traffic.
    expect(() => inClusterClient(config())).toThrow(/no in-cluster namespace/)
  })
})
