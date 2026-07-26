import { describe, expect, it } from 'vitest'
import {
  MAX_CLAIMS_PER_NAMESPACE,
  MAX_SOURCES_PER_CLAIM,
  parseClaimsConfigMap,
  parseInnerClaimDocument,
  parseRedirectClaim,
  renderInnerClaimDocument,
  renderNamespaceClaims,
} from 'yaac-netd/claims'

const CLAIM = { install: 'hash1', proxyPodIp: '10.244.0.31', sources: ['10.244.0.44'] }

describe('parseRedirectClaim', () => {
  it('accepts a well-formed claim', () => {
    expect(parseRedirectClaim(CLAIM)).toEqual(CLAIM)
  })

  it('defaults a missing source list to empty rather than failing', () => {
    expect(parseRedirectClaim({ install: 'h', proxyPodIp: '10.244.0.31' }))
      .toEqual({ install: 'h', proxyPodIp: '10.244.0.31', sources: [] })
  })

  it('drops sources that are not strings', () => {
    expect(parseRedirectClaim({ ...CLAIM, sources: ['10.244.0.44', 42, null, {}] })?.sources)
      .toEqual(['10.244.0.44'])
  })

  it('rejects anything without an install and a target', () => {
    for (const bad of [null, 'string', 42, {}, { install: 'h' }, { proxyPodIp: '10.244.0.31' },
      { install: '', proxyPodIp: '10.244.0.31' }, { install: 'h', proxyPodIp: '' },
      { install: 'h'.repeat(200), proxyPodIp: '10.244.0.31' }]) {
      expect(parseRedirectClaim(bad)).toBeNull()
    }
  })

  it('bounds the source list at parse time', () => {
    const many = Array.from({ length: MAX_SOURCES_PER_CLAIM + 50 }, (_, i) => `10.244.1.${i % 256}`)
    expect(parseRedirectClaim({ ...CLAIM, sources: many })?.sources.length)
      .toBe(MAX_SOURCES_PER_CLAIM)
  })
})

describe('parseInnerClaimDocument', () => {
  it('round-trips what claim mode renders', () => {
    expect(parseInnerClaimDocument(renderInnerClaimDocument(CLAIM))).toEqual(CLAIM)
  })

  it('treats the empty document as no claim — that is how claim mode retracts', () => {
    expect(parseInnerClaimDocument('')).toBeNull()
    expect(parseInnerClaimDocument('   ')).toBeNull()
    expect(parseInnerClaimDocument(undefined)).toBeNull()
  })

  it('never throws on tenant-authored garbage', () => {
    for (const bad of ['{', 'null', '[]', '"str"', '{"install":"h"}']) {
      expect(parseInnerClaimDocument(bad)).toBeNull()
    }
  })
})

describe('renderInnerClaimDocument', () => {
  it('sorts and dedupes sources so an unchanged claim is byte-stable', () => {
    const a = renderInnerClaimDocument({ ...CLAIM, sources: ['10.244.0.9', '10.244.0.44', '10.244.0.9'] })
    const b = renderInnerClaimDocument({ ...CLAIM, sources: ['10.244.0.44', '10.244.0.9'] })
    expect(a).toBe(b)
    expect((JSON.parse(a) as { sources: string[] }).sources).toEqual(['10.244.0.44', '10.244.0.9'])
  })
})

describe('renderNamespaceClaims', () => {
  it('renders what parseClaimsConfigMap reads back', () => {
    const value = renderNamespaceClaims({ vcluster: 'yvc1', claims: [CLAIM] })
    expect(parseClaimsConfigMap({ 'yaac-vc-abc': value }).get('yaac-vc-abc'))
      .toEqual({ vcluster: 'yvc1', claims: [CLAIM] })
  })

  it('bounds the claim list', () => {
    const claims = Array.from({ length: MAX_CLAIMS_PER_NAMESPACE + 10 }, (_, i) => ({
      ...CLAIM, install: `h${i}`,
    }))
    const rendered = JSON.parse(renderNamespaceClaims({ vcluster: 'v', claims })) as {
      claims: unknown[]
    }
    expect(rendered.claims.length).toBe(MAX_CLAIMS_PER_NAMESPACE)
  })
})

describe('parseClaimsConfigMap', () => {
  it('reads one entry per vcluster namespace', () => {
    const data = {
      'yaac-vc-a': renderNamespaceClaims({ vcluster: 'va', claims: [CLAIM] }),
      'yaac-vc-b': renderNamespaceClaims({ vcluster: 'vb', claims: [] }),
    }
    const parsed = parseClaimsConfigMap(data)
    expect([...parsed.keys()]).toEqual(['yaac-vc-a', 'yaac-vc-b'])
    expect(parsed.get('yaac-vc-b')?.claims).toEqual([])
  })

  it('drops a corrupt entry without losing the healthy ones', () => {
    const parsed = parseClaimsConfigMap({
      'yaac-vc-a': '{ not json',
      'yaac-vc-b': renderNamespaceClaims({ vcluster: 'vb', claims: [CLAIM] }),
      'yaac-vc-c': JSON.stringify({ claims: [CLAIM] }), // no vcluster name
    })
    expect([...parsed.keys()]).toEqual(['yaac-vc-b'])
  })

  it('drops individual malformed claims inside a valid entry', () => {
    const parsed = parseClaimsConfigMap({
      'yaac-vc-a': JSON.stringify({ vcluster: 'va', claims: [CLAIM, { install: 'h' }, 7] }),
    })
    expect(parsed.get('yaac-vc-a')?.claims).toEqual([CLAIM])
  })

  it('is empty for a missing or data-less ConfigMap', () => {
    expect(parseClaimsConfigMap(undefined).size).toBe(0)
    expect(parseClaimsConfigMap({}).size).toBe(0)
  })
})
