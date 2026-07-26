import { describe, expect, it } from 'vitest'
import type { NamespaceClaims, RedirectClaim } from 'yaac-netd/claims'
import {
  LABEL_SESSION_ID,
  LABEL_VCLUSTER_MANAGED_BY,
  PROXY_APP_NAME,
  distinctTargets,
  isOwnVclusterNamespace,
  selectClaimProxyPodIp,
  selectTargets,
  validateClaims,
  type NetdPod,
} from 'yaac-netd/targets'

const INSTALL_NS = 'yaac'
const VC_NS = 'yaac-vc-abc'
const VC_NAME = 'yvc1'
const OUTER_IP = '10.96.0.50'
/** The inner proxy is a POD, so its address is a pod IP, never a ClusterIP. */
const INNER_POD_IP = '10.244.0.31'
const POD_CIDRS = ['10.244.0.0/16']

function pod(name: string, namespace: string, labels: Record<string, string>, podIp = '10.244.0.9'): NetdPod {
  return { name, namespace, podIp, labels }
}

/** A synced pod: what the syncer stamps is what containment keys on. */
function synced(name: string, podIp: string, labels: Record<string, string> = {}, namespace = VC_NS): NetdPod {
  return pod(name, namespace, { [LABEL_VCLUSTER_MANAGED_BY]: VC_NAME, ...labels }, podIp)
}

function claims(
  entries: RedirectClaim[],
  namespace = VC_NS,
  vcluster = VC_NAME,
): Map<string, NamespaceClaims> {
  return new Map([[namespace, { vcluster, claims: entries }]])
}

function select(pods: NetdPod[], claimed?: Map<string, NamespaceClaims>) {
  return selectTargets({
    pods,
    installNamespace: INSTALL_NS,
    outerProxyClusterIp: OUTER_IP,
    ...(claimed ? { claims: claimed } : {}),
    podCidrs: POD_CIDRS,
  })
}

describe('isOwnVclusterNamespace', () => {
  it('matches the server\'s <install>-vc-<name> convention', () => {
    expect(isOwnVclusterNamespace('yaac-vc-abc', 'yaac')).toBe(true)
    expect(isOwnVclusterNamespace('yaac-test-r1-vc-abc', 'yaac-test-r1')).toBe(true)
  })

  it('rejects another install\'s vcluster namespaces, including prefix lookalikes', () => {
    // The e2e install's namespace starts with the real install's name, so a
    // bare `startsWith(installNamespace)` would wrongly claim it.
    expect(isOwnVclusterNamespace('yaac-test-r1-vc-abc', 'yaac')).toBe(false)
    expect(isOwnVclusterNamespace('yaac-vc-abc', 'yaac-test-r1')).toBe(false)
  })

  it('rejects the install namespace itself and unrelated namespaces', () => {
    expect(isOwnVclusterNamespace('yaac', 'yaac')).toBe(false)
    expect(isOwnVclusterNamespace('kube-system', 'yaac')).toBe(false)
  })
})

describe('validateClaims', () => {
  const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
  const sessionPod = synced('inner-sess', '10.244.0.44', { [LABEL_SESSION_ID]: 'i1' })
  const claim: RedirectClaim = {
    install: 'hash1',
    proxyPodIp: INNER_POD_IP,
    sources: [sessionPod.podIp],
  }
  const validate = (
    entries: Map<string, NamespaceClaims>,
    pods = [proxyPod, sessionPod],
    podCidrs = POD_CIDRS,
  ) => validateClaims({ claims: entries, pods, installNamespace: INSTALL_NS, podCidrs })

  it('keeps a claim whose target and sources are live synced pods of that vcluster', () => {
    expect(validate(claims([claim])).get(VC_NS)).toEqual([claim])
  })

  it('rejects an off-cluster target — the exfiltration case this exists for', () => {
    // A tenant naming any address outside the pod population (a Service
    // ClusterIP, a public IP) must not be reachable: kube-proxy would
    // dereference it from the node netns, where no NetworkPolicy applies.
    expect(validate(claims([{ ...claim, proxyPodIp: '203.0.113.7' }])).size).toBe(0)
    expect(validate(claims([{ ...claim, proxyPodIp: '10.96.0.77' }])).size).toBe(0)
  })

  it('rejects a target inside the pod CIDRs that is not a live synced pod IP', () => {
    expect(validate(claims([{ ...claim, proxyPodIp: '10.244.0.250' }])).size).toBe(0)
  })

  it('rejects a target pod that is not managed by the named vcluster', () => {
    // A pod in the namespace without the syncer's stamp (or with another
    // vcluster's) is not part of the population a claim may name.
    const unstamped = pod('bare', VC_NS, { app: PROXY_APP_NAME }, INNER_POD_IP)
    expect(validate(claims([claim]), [unstamped, sessionPod]).size).toBe(0)
  })

  it('rejects a claim for a namespace this install does not own', () => {
    const foreign = 'yaac-test-r1-vc-demo'
    const theirs = synced('theirs', INNER_POD_IP, {}, foreign)
    expect(validate(claims([claim], foreign), [theirs]).size).toBe(0)
  })

  it('drops sources that are not synced pods of that vcluster, keeping the rest', () => {
    const withGhosts = { ...claim, sources: [sessionPod.podIp, '10.244.9.9', '203.0.113.7'] }
    expect(validate(claims([withGhosts])).get(VC_NS)?.[0].sources).toEqual([sessionPod.podIp])
  })

  it('drops the claim entirely when no source survives', () => {
    expect(validate(claims([{ ...claim, sources: ['10.244.9.9'] }])).size).toBe(0)
  })

  it('never lets a claim redirect its own proxy (that would loop)', () => {
    const selfClaim = { ...claim, sources: [sessionPod.podIp, INNER_POD_IP] }
    expect(validate(claims([selfClaim])).get(VC_NS)?.[0].sources).toEqual([sessionPod.podIp])
  })

  it('orders claims by install hash so a contested source resolves stably', () => {
    const second = synced('proxy-b', '10.244.0.32', { app: PROXY_APP_NAME })
    const entries = claims([
      { install: 'zzz', proxyPodIp: second.podIp, sources: [sessionPod.podIp] },
      { install: 'aaa', proxyPodIp: INNER_POD_IP, sources: [sessionPod.podIp] },
    ])
    expect(validate(entries, [proxyPod, second, sessionPod]).get(VC_NS)?.map((c) => c.install))
      .toEqual(['aaa', 'zzz'])
  })

  it('bounds a claim\'s source list (a tenant-writable document must not amplify)', () => {
    const many = Array.from({ length: 600 }, (_, i) => `10.244.1.${i % 256}`)
    const pods = [proxyPod, ...many.map((ip, i) => synced(`s${i}`, ip))]
    const sources = validate(claims([{ ...claim, sources: many }]), pods).get(VC_NS)?.[0].sources
    expect(sources?.length).toBe(512)
  })

  it('bounds the number of claims per namespace', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      install: `h${String(i).padStart(3, '0')}`,
      proxyPodIp: INNER_POD_IP,
      sources: [sessionPod.podIp],
    }))
    expect(validate(claims(entries)).get(VC_NS)?.length).toBe(64)
  })

  it('returns nothing when there are no claims at all', () => {
    expect(validate(new Map()).size).toBe(0)
  })
})

describe('selectTargets', () => {
  it('rule 1: an install-namespace session pod goes to the outer proxy', () => {
    const p = pod('sess-1', INSTALL_NS, { [LABEL_SESSION_ID]: 's1' })
    expect(select([p])).toEqual([{ pod: p, target: { key: `outer/${INSTALL_NS}`, ip: OUTER_IP } }])
  })

  it('never redirects the outer proxy itself (a self-redirect would loop)', () => {
    expect(select([pod('proxy', INSTALL_NS, { app: PROXY_APP_NAME })])).toEqual([])
  })

  it('ignores non-session pods in the install namespace', () => {
    expect(select([pod('registry', INSTALL_NS, { app: 'yaac-registry' })])).toEqual([])
  })

  it('ignores pods with no IP yet', () => {
    expect(select([pod('sess', INSTALL_NS, { [LABEL_SESSION_ID]: 's' }, '')])).toEqual([])
  })

  it('rule 2: a claimed synced pod is redirected to the claimed proxy pod IP', () => {
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const p = synced('inner-sess', '10.244.0.44', { [LABEL_SESSION_ID]: 'i1' })
    const selected = select([proxyPod, p], claims([
      { install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [p.podIp] },
    ]))
    expect(selected.find((s) => s.pod.name === 'inner-sess')?.target).toEqual({
      key: `inner/${VC_NS}/hash1`, ip: INNER_POD_IP,
    })
  })

  it('rule 3: the claimed proxy itself stays on the outer proxy, so chaining is loop-free', () => {
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const p = synced('inner-sess', '10.244.0.44', { [LABEL_SESSION_ID]: 'i1' })
    const selected = select([proxyPod, p], claims([
      { install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [p.podIp] },
    ]))
    expect(selected.find((s) => s.pod.name === 'inner-proxy')?.target.ip).toBe(OUTER_IP)
  })

  it('rule 3: an unclaimed synced pod falls back to the outer proxy', () => {
    expect(select([synced('synced', '10.244.0.44')])[0].target.ip).toBe(OUTER_IP)
  })

  it('rule 3: a synced pod claimed by nobody, in a vcluster with claims, still falls back', () => {
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const claimed = synced('claimed', '10.244.0.44')
    const other = synced('other', '10.244.0.45')
    const selected = select([proxyPod, claimed, other], claims([
      { install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [claimed.podIp] },
    ]))
    expect(selected.find((s) => s.pod.name === 'other')?.target.ip).toBe(OUTER_IP)
  })

  it('a forged claim is non-escalating: it can only name a pod in its own vcluster', () => {
    // The tenant's own pod, claimed as a proxy. Its own egress still rides
    // rule 3 to the outer proxy, so the reachable set does not grow.
    const rogue = synced('rogue', '10.244.0.60')
    const victim = synced('victim', '10.244.0.61')
    const selected = select([rogue, victim], claims([
      { install: 'forged', proxyPodIp: rogue.podIp, sources: [victim.podIp] },
    ]))
    expect(selected.find((s) => s.pod.name === 'victim')?.target.ip).toBe(rogue.podIp)
    expect(selected.find((s) => s.pod.name === 'rogue')?.target.ip).toBe(OUTER_IP)
  })

  it('a claim in one vcluster does not redirect pods in another', () => {
    const otherVc = 'yaac-vc-other'
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const elsewhere = pod('elsewhere', otherVc, {
      [LABEL_VCLUSTER_MANAGED_BY]: 'yvc2',
    }, '10.244.0.44')
    const selected = select([proxyPod, elsewhere], claims([
      { install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [elsewhere.podIp] },
    ]))
    expect(selected.find((s) => s.pod.name === 'elsewhere')?.target.ip).toBe(OUTER_IP)
  })

  it('never claims a synced pod in ANOTHER install\'s vcluster namespace', () => {
    // The bug this guards: netd watches every namespace, so without the
    // ownership check the real install's netd redirects an e2e install's
    // synced pods at its own proxy. Both installs append a PREROUTING jump,
    // so the first-appended chain wins and the loser's pods reach a proxy
    // that cannot resolve them — silent, total egress loss for whichever
    // install lost, decided by restart order.
    const foreignVcNs = 'yaac-test-r1-vc-demo'
    expect(select([pod('theirs', foreignVcNs, { [LABEL_VCLUSTER_MANAGED_BY]: 'yvc-demo' })]))
      .toEqual([])
  })

  it('does not honour a claim across an install boundary either', () => {
    const foreignVcNs = 'yaac-test-r1-vc-demo'
    const theirProxy = synced('proxy', INNER_POD_IP, { app: PROXY_APP_NAME }, foreignVcNs)
    const theirPod = synced('theirs', '10.244.0.44', {}, foreignVcNs)
    expect(select([theirProxy, theirPod], claims([
      { install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [theirPod.podIp] },
    ], foreignVcNs))).toEqual([])
  })

  it('still claims our own vcluster\'s synced pods (the positive path)', () => {
    const mine = synced('mine', '10.244.0.44')
    const theirs = pod('theirs', 'yaac-test-r1-vc-demo', { [LABEL_VCLUSTER_MANAGED_BY]: 'yvc-demo' })
    expect(select([mine, theirs]).map((s) => s.pod.name)).toEqual(['mine'])
  })

  it('selects nothing at all when the outer proxy is not up yet', () => {
    expect(selectTargets({
      pods: [pod('sess', INSTALL_NS, { [LABEL_SESSION_ID]: 's' })],
      installNamespace: INSTALL_NS,
      outerProxyClusterIp: null,
    })).toEqual([])
  })

  it('still honours claims when the outer proxy is down (inner egress is independent)', () => {
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const p = synced('inner-sess', '10.244.0.44')
    const selected = selectTargets({
      pods: [proxyPod, p],
      installNamespace: INSTALL_NS,
      outerProxyClusterIp: null,
      claims: claims([{ install: 'h', proxyPodIp: INNER_POD_IP, sources: [p.podIp] }]),
      podCidrs: POD_CIDRS,
    })
    expect(selected.map((s) => s.pod.name)).toEqual(['inner-sess'])
  })

  it('is stably ordered so renderings are byte-stable between passes', () => {
    const a = pod('a', INSTALL_NS, { [LABEL_SESSION_ID]: '1' })
    const b = pod('b', INSTALL_NS, { [LABEL_SESSION_ID]: '2' })
    expect(select([b, a]).map((s) => s.pod.name)).toEqual(['a', 'b'])
  })
})

describe('selectClaimProxyPodIp', () => {
  it('picks this install\'s proxy pod', () => {
    const pods = [
      pod('sess', INSTALL_NS, { [LABEL_SESSION_ID]: 's' }, '10.244.0.9'),
      pod('proxy', INSTALL_NS, { app: PROXY_APP_NAME }, '10.244.0.31'),
    ]
    expect(selectClaimProxyPodIp(pods, INSTALL_NS)).toBe('10.244.0.31')
  })

  it('picks the lowest IP mid-rollout so the claim does not flap', () => {
    const pods = [
      pod('proxy-new', INSTALL_NS, { app: PROXY_APP_NAME }, '10.244.0.32'),
      pod('proxy-old', INSTALL_NS, { app: PROXY_APP_NAME }, '10.244.0.31'),
    ]
    expect(selectClaimProxyPodIp(pods, INSTALL_NS)).toBe('10.244.0.31')
  })

  it('ignores proxies in other namespaces and pods with no IP', () => {
    expect(selectClaimProxyPodIp([
      pod('proxy', 'other', { app: PROXY_APP_NAME }, '10.244.0.31'),
      pod('pending', INSTALL_NS, { app: PROXY_APP_NAME }, ''),
    ], INSTALL_NS)).toBeNull()
  })

  it('is null when no proxy is up — how claim mode retracts', () => {
    expect(selectClaimProxyPodIp([], INSTALL_NS)).toBeNull()
  })
})

describe('distinctTargets', () => {
  it('dedupes by key in stable order', () => {
    const proxyPod = synced('inner-proxy', INNER_POD_IP, { app: PROXY_APP_NAME })
    const inner = synced('i1', '10.244.0.44')
    const selected = select([
      pod('s1', INSTALL_NS, { [LABEL_SESSION_ID]: '1' }),
      pod('s2', INSTALL_NS, { [LABEL_SESSION_ID]: '2' }),
      proxyPod,
      inner,
    ], claims([{ install: 'hash1', proxyPodIp: INNER_POD_IP, sources: [inner.podIp] }]))
    expect(distinctTargets(selected).map((t) => t.key)).toEqual([
      `inner/${VC_NS}/hash1`, `outer/${INSTALL_NS}`,
    ])
  })
})
