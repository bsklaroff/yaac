import { describe, it, expect } from 'vitest'
import { PodSessionIndex, podSessionId, parseVclusterAttribution } from 'yaac-proxy-sidecar/pod-watch'
import type { WatchedPod } from 'yaac-proxy-sidecar/pod-watch'

function pod(ip: string | undefined, sid: string | undefined): WatchedPod {
  return {
    metadata: sid === undefined ? {} : { labels: { 'yaac.session-id': sid } },
    status: ip === undefined ? {} : { podIP: ip },
  }
}

describe('podSessionId', () => {
  it('returns the session id when the pod has an IP and the label', () => {
    expect(podSessionId(pod('10.0.0.1', 'sess-a'))).toBe('sess-a')
  })

  it('returns null without an IP or without the label', () => {
    expect(podSessionId(pod(undefined, 'sess-a'))).toBeNull()
    expect(podSessionId(pod('10.0.0.1', undefined))).toBeNull()
  })
})

describe('PodSessionIndex', () => {
  it('upserts on ADDED/MODIFIED and resolves by IP', () => {
    const idx = new PodSessionIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-a')
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', 'sess-b') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-b')
  })

  it('evicts on DELETED so a reused IP cannot be misattributed', () => {
    const idx = new PodSessionIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'DELETED', object: pod('10.0.0.1', 'sess-a') })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    // The IP is now free to be a different session.
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-c') })
    expect(idx.resolve('10.0.0.1')).toBe('sess-c')
  })

  it('ignores a pod with no IP and evicts one that lost its session label', () => {
    const idx = new PodSessionIndex()
    idx.apply({ type: 'ADDED', object: pod(undefined, 'sess-a') })
    expect(idx.size).toBe(0)
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'MODIFIED', object: pod('10.0.0.1', undefined) })
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
  })

  it('replaceAll rebuilds the index and evicts pods that vanished', () => {
    const idx = new PodSessionIndex()
    idx.apply({ type: 'ADDED', object: pod('10.0.0.1', 'sess-a') })
    idx.apply({ type: 'ADDED', object: pod('10.0.0.2', 'sess-b') })
    // A re-list that no longer contains 10.0.0.1 drops it.
    idx.replaceAll([pod('10.0.0.2', 'sess-b'), pod('10.0.0.3', 'sess-c')])
    expect(idx.resolve('10.0.0.1')).toBeUndefined()
    expect(idx.resolve('10.0.0.2')).toBe('sess-b')
    expect(idx.resolve('10.0.0.3')).toBe('sess-c')
  })

  it('set() seeds an entry (the cache-miss fallback path)', () => {
    const idx = new PodSessionIndex()
    idx.set('10.0.0.9', 'sess-z')
    expect(idx.resolve('10.0.0.9')).toBe('sess-z')
  })
})

describe('parseVclusterAttribution', () => {
  it('parses a flat podIP→sessionId map', () => {
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
