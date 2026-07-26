import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CDS_PATH,
  LDS_PATH,
  type ConfirmListenersInput,
  type NetdConfig,
  type ReconcileDeps,
  type ReconcileMemo,
  loadClaimConfig,
  loadConfig,
  netdMode,
  publishClaimOnce,
  reconcileOnce,
  type ClaimMemo,
  type ClaimReconcileDeps,
  type NetdClaimConfig,
} from 'yaac-netd/netd'
import { ListenerRejectedError } from 'yaac-netd/envoy-admin'
import { redirectChainName } from 'yaac-netd/rules'
import {
  CLAIMS_CONFIGMAP_NAME,
  renderNamespaceClaims,
  type NetdConfigMap,
} from 'yaac-netd/claims'
import type { NetdPod, NetdService } from 'yaac-netd/targets'

const ENV_KEYS = [
  'YAAC_NAMESPACE', 'NODE_NAME', 'NODE_IP', 'CLUSTER_POD_CIDRS', 'SSH_TUNNEL_SENTINEL',
  'TUNNEL_INGRESS_PORT', 'TRANSPARENT_HTTPS_PORT', 'TRANSPARENT_HTTP_PORT',
  'TRANSPARENT_TUNNEL_PORT', 'NETD_LISTENER_PORT_BASE', 'NETD_LISTENER_SLOTS',
]

describe('loadConfig', () => {
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.YAAC_NAMESPACE = 'yaac'
    process.env.NODE_NAME = 'kind-control-plane'
    process.env.NODE_IP = '10.89.0.7'
    process.env.CLUSTER_POD_CIDRS = '10.244.0.0/16'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('reads the install identity the DaemonSet passes', () => {
    const config = loadConfig()
    expect(config.installNamespace).toBe('yaac')
    expect(config.nodeName).toBe('kind-control-plane')
    expect(config.nodeIp).toBe('10.89.0.7')
  })

  it('refuses to start without an install namespace', () => {
    delete process.env.YAAC_NAMESPACE
    expect(() => loadConfig()).toThrow(/YAAC_NAMESPACE is required/)
  })

  it('refuses to start with no pod CIDR', () => {
    // With nothing to RETURN on, the chain would DNAT pod-to-pod 443/80
    // into the proxy. Refusing costs egress; guessing corrupts in-cluster
    // traffic.
    delete process.env.CLUSTER_POD_CIDRS
    expect(() => loadConfig()).toThrow(/CLUSTER_POD_CIDRS is required/)
    process.env.CLUSTER_POD_CIDRS = ' , '
    expect(() => loadConfig()).toThrow(/CLUSTER_POD_CIDRS is empty/)
  })

  it('splits and trims a multi-CIDR list', () => {
    process.env.CLUSTER_POD_CIDRS = '10.244.0.0/16, 192.168.0.0/16'
    expect(loadConfig().podCidrs).toEqual(['10.244.0.0/16', '192.168.0.0/16'])
  })

  it('takes the listener range from the env so it matches the NetworkPolicy', () => {
    process.env.NETD_LISTENER_PORT_BASE = '16000'
    process.env.NETD_LISTENER_SLOTS = '10'
    expect(loadConfig().listenerRange).toEqual({ base: 16000, slots: 10 })
  })

  it('falls back to the documented range and ports when the env is absent', () => {
    const config = loadConfig()
    expect(config.listenerRange).toEqual({ base: 15100, slots: 300 })
    expect(config.transparentPorts).toEqual({ https: 10256, http: 10257, tunnel: 10258 })
    expect(config.sshSentinelIp).toBe('198.18.0.2')
    expect(config.sshSentinelPort).toBe(10259)
  })

  it('ignores a non-numeric port rather than propagating NaN into a rule', () => {
    process.env.TRANSPARENT_HTTPS_PORT = 'not-a-port'
    expect(loadConfig().transparentPorts.https).toBe(10256)
  })
})

describe('netdMode', () => {
  let saved: string | undefined

  beforeEach(() => { saved = process.env.NETD_MODE })
  afterEach(() => {
    if (saved === undefined) delete process.env.NETD_MODE
    else process.env.NETD_MODE = saved
  })

  it('selects claim mode only on the exact opt-in', () => {
    process.env.NETD_MODE = 'claim'
    expect(netdMode()).toBe('claim')
  })

  it('defaults to host mode for anything else', () => {
    // Host mode is the one that programs the node, so an unset or
    // misspelled value must not silently produce a netd that programs
    // nothing while reporting Ready.
    delete process.env.NETD_MODE
    expect(netdMode()).toBe('host')
    process.env.NETD_MODE = 'Claim'
    expect(netdMode()).toBe('host')
  })
})

describe('loadClaimConfig', () => {
  const KEYS = ['YAAC_NAMESPACE', 'YAAC_DATA_DIR_HASH']
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    process.env.YAAC_NAMESPACE = 'yaac-inner'
    process.env.YAAC_DATA_DIR_HASH = 'abc123'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('reads the inner install identity a claim is signed with', () => {
    expect(loadClaimConfig()).toEqual({ installNamespace: 'yaac-inner', installHash: 'abc123' })
  })

  it('refuses to start without either half of the identity', () => {
    // A claim naming the wrong install (or an empty one) is one the host
    // netd would reject anyway; failing here makes that a startup error
    // instead of a silently ignored claim.
    delete process.env.YAAC_DATA_DIR_HASH
    expect(() => loadClaimConfig()).toThrow(/YAAC_DATA_DIR_HASH is required/)
    process.env.YAAC_DATA_DIR_HASH = 'abc123'
    delete process.env.YAAC_NAMESPACE
    expect(() => loadClaimConfig()).toThrow(/YAAC_NAMESPACE is required/)
  })
})

const CONFIG: NetdConfig = {
  installNamespace: 'yaac',
  nodeName: 'node-1',
  nodeIp: '10.89.0.7',
  podCidrs: ['10.244.0.0/16'],
  sshSentinelIp: '198.18.0.2',
  sshSentinelPort: 10259,
  transparentPorts: { https: 10256, http: 10257, tunnel: 10258 },
  listenerRange: { base: 15100, slots: 300 },
}

const PROXY_SVC: NetdService = {
  name: 'yaac-proxy', namespace: 'yaac', clusterIp: '10.96.0.50', labels: { app: 'yaac-proxy' },
}
const SESSION_POD: NetdPod = {
  name: 'sess-1', namespace: 'yaac', podIp: '10.244.0.9', labels: { 'yaac.session-id': 's1' },
}

interface Harness {
  deps: ReconcileDeps
  memo: ReconcileMemo
  calls: string[]
  written: Map<string, string>
  confirmed: ConfirmListenersInput[]
  setPods: (pods: NetdPod[]) => void
  setClaims: (data: Record<string, string>) => void
  setConfirm: (fn: (input: ConfirmListenersInput) => Promise<void>) => void
}

function harness(overrides: Partial<ReconcileDeps> = {}): Harness {
  const calls: string[] = []
  const written = new Map<string, string>()
  const confirmed: ConfirmListenersInput[] = []
  let pods: NetdPod[] = [SESSION_POD]
  let configMaps: NetdConfigMap[] = []
  let confirm: (input: ConfirmListenersInput) => Promise<void> = () => Promise.resolve()

  const deps: ReconcileDeps = {
    config: CONFIG,
    backend: 'legacy',
    chain: redirectChainName(CONFIG.installNamespace),
    pods: () => pods,
    services: () => [PROXY_SVC],
    configMaps: () => configMaps,
    routes: () => Promise.resolve('10.244.0.9 dev calia1 scope link\n'),
    trio: () => Promise.resolve({ https: 15100, http: 15101, tunnel: 15102 }),
    confirmListeners: (input) => {
      calls.push('confirm')
      confirmed.push(input)
      return confirm(input)
    },
    applyChain: (doc) => { calls.push('applyChain'); written.set('chain', doc); return Promise.resolve() },
    ensureJump: () => { calls.push('ensureJump'); return Promise.resolve() },
    writeEnvoy: (file, content) => {
      calls.push(file === LDS_PATH ? 'writeLds' : file === CDS_PATH ? 'writeCds' : 'writeOther')
      written.set(file, content)
      return Promise.resolve()
    },
    log: () => { /* quiet */ },
    ...overrides,
  }
  return {
    deps,
    memo: {},
    calls,
    written,
    confirmed,
    setPods: (next) => { pods = next },
    setClaims: (data) => {
      configMaps = [{ name: CLAIMS_CONFIGMAP_NAME, namespace: CONFIG.installNamespace, data }]
    },
    setConfirm: (fn) => { confirm = fn },
  }
}

describe('reconcileOnce', () => {
  it('writes Envoy, waits for it, and only THEN programs netfilter', async () => {
    // A rule naming a port Envoy has not bound black-holes the flows it
    // captures, so this order is the whole point of the gate.
    const h = harness()
    await reconcileOnce(h.deps, h.memo)
    expect(h.calls).toEqual(['writeCds', 'writeLds', 'confirm', 'applyChain', 'ensureJump'])
  })

  it('waits for the exact LDS version it just wrote', async () => {
    const h = harness()
    await reconcileOnce(h.deps, h.memo)
    const lds = JSON.parse(h.written.get(LDS_PATH)!) as { version_info: string }
    expect(h.confirmed[0]?.version).toBe(lds.version_info)
    expect(h.confirmed[0]?.ports).toEqual([15100, 15101, 15102])
    expect(h.confirmed[0]?.names).toEqual([
      'yaac-listener-yaac-https', 'yaac-listener-yaac-http', 'yaac-listener-yaac-tunnel',
    ])
  })

  it('writes nothing on an unchanged pass, but still re-asserts the jump', async () => {
    // A jump deleted out from under netd is invisible in the rendering,
    // so nothing else would ever notice it was gone.
    const h = harness()
    await reconcileOnce(h.deps, h.memo)
    h.calls.length = 0
    const changed = await reconcileOnce(h.deps, h.memo)
    expect(changed).toEqual([])
    expect(h.calls).toEqual(['confirm', 'ensureJump'])
  })

  it('re-applies the chain on a resync pass even when nothing changed', async () => {
    // The memo describes what netd WROTE, not what the kernel kept — only
    // a pass that discards it can heal an external flush.
    const h = harness()
    await reconcileOnce(h.deps, h.memo)
    h.calls.length = 0
    const changed = await reconcileOnce(h.deps, h.memo, { resync: true })
    expect(h.calls).toEqual(['confirm', 'applyChain', 'ensureJump'])
    expect(changed.join()).toMatch(/^rules\(/)
  })

  it('does not touch netfilter when Envoy rejected the listeners', async () => {
    const h = harness()
    h.setConfirm(() => Promise.reject(new ListenerRejectedError('address already in use')))
    await expect(reconcileOnce(h.deps, h.memo)).rejects.toThrow(ListenerRejectedError)
    expect(h.calls).not.toContain('applyChain')
    expect(h.calls).not.toContain('ensureJump')
  })

  it('reports the pods and targets it programmed', async () => {
    const h = harness()
    const changed = await reconcileOnce(h.deps, h.memo)
    expect(changed[0]).toBe('cds(1 targets)')
    expect(changed[1]).toContain('15100/15101/15102')
    // 1 pod-CIDR RETURN + 3 DNAT rules.
    expect(changed[2]).toBe('rules(4 for 1 pods)')
  })

  it('rewrites both documents when the pod set changes', async () => {
    const h = harness()
    await reconcileOnce(h.deps, h.memo)
    h.calls.length = 0
    h.setPods([SESSION_POD, {
      name: 'sess-2', namespace: 'yaac', podIp: '10.244.0.10', labels: { 'yaac.session-id': 's2' },
    }])
    h.deps.routes = () => Promise.resolve(
      '10.244.0.9 dev calia1 scope link\n10.244.0.10 dev calib2 scope link\n',
    )
    await reconcileOnce(h.deps, h.memo)
    // Same single target, so CDS is unchanged; the LDS filter chain gains
    // a source, and the chain gains that pod's rules.
    expect(h.calls).toEqual(['writeLds', 'confirm', 'applyChain', 'ensureJump'])
  })

  it('programs nothing at all when the proxy Service is not up yet', async () => {
    const h = harness({ services: () => [] })
    await reconcileOnce(h.deps, h.memo)
    expect(h.confirmed[0]?.names).toEqual([])
    const chain = h.written.get('chain')!
    expect(chain).not.toContain('DNAT')
    // The pod-CIDR exclusion still stands, so nothing is redirected.
    expect(chain).toContain('-d 10.244.0.0/16 -j RETURN')
  })

  it('emits no rule for a pod whose veth Calico has not programmed', async () => {
    const h = harness({ routes: () => Promise.resolve('') })
    await reconcileOnce(h.deps, h.memo)
    expect(h.written.get('chain')).not.toContain('DNAT')
  })

  it('points every pod at the one install trio, whatever its target', async () => {
    const h = harness()
    h.setPods([SESSION_POD, {
      name: 'synced',
      namespace: 'yaac-vc-demo',
      podIp: '10.244.0.20',
      labels: { 'vcluster.loft.sh/managed-by': 'yvc-demo' },
    }])
    h.deps.routes = () => Promise.resolve(
      '10.244.0.9 dev calia1 scope link\n10.244.0.20 dev calib2 scope link\n',
    )
    await reconcileOnce(h.deps, h.memo)
    const chain = h.written.get('chain')!
    expect(chain).toContain('10.89.0.7:15100')
    expect(chain.match(/--to-destination 10\.89\.0\.7:15100/g)).toHaveLength(2)
  })
})

describe('reconcileOnce with redirect claims', () => {
  const VC_NS = 'yaac-vc-demo'
  const INNER_PROXY: NetdPod = {
    name: 'inner-proxy', namespace: VC_NS, podIp: '10.244.0.31',
    labels: { 'vcluster.loft.sh/managed-by': 'yvc-demo', app: 'yaac-proxy' },
  }
  const INNER_SESS: NetdPod = {
    name: 'inner-sess', namespace: VC_NS, podIp: '10.244.0.44',
    labels: { 'vcluster.loft.sh/managed-by': 'yvc-demo' },
  }
  const ROUTES = '10.244.0.9 dev calia1 scope link\n'
    + '10.244.0.31 dev calib2 scope link\n10.244.0.44 dev calic3 scope link\n'

  it('renders an Envoy cluster on the claimed proxy POD IP, not a ClusterIP', async () => {
    const h = harness({ routes: () => Promise.resolve(ROUTES) })
    h.setPods([SESSION_POD, INNER_PROXY, INNER_SESS])
    h.setClaims({
      [VC_NS]: renderNamespaceClaims({
        vcluster: 'yvc-demo',
        claims: [{ install: 'h1', proxyPodIp: '10.244.0.31', sources: ['10.244.0.44'] }],
      }),
    })
    await reconcileOnce(h.deps, h.memo)
    const cds = h.written.get(CDS_PATH)!
    expect(cds).toContain('10.244.0.31')
    // Target keys are sanitized into Envoy resource names (resourceName).
    expect(cds).toContain(`yaac-inner-${VC_NS}-h1-https`)
    // Both targets are served: the claimed inner proxy and the outer one
    // the claimed proxy's own egress rides (rule 3).
    expect(cds).toContain('10.96.0.50')
  })

  it('ignores a claim naming an address outside the pod CIDRs', async () => {
    // The bypass this guards: a tenant-authored target that kube-proxy (or
    // anything else) would dereference off-cluster from the node netns.
    const h = harness({ routes: () => Promise.resolve(ROUTES) })
    h.setPods([SESSION_POD, INNER_PROXY, INNER_SESS])
    h.setClaims({
      [VC_NS]: renderNamespaceClaims({
        vcluster: 'yvc-demo',
        claims: [{ install: 'evil', proxyPodIp: '203.0.113.7', sources: ['10.244.0.44'] }],
      }),
    })
    await reconcileOnce(h.deps, h.memo)
    const cds = h.written.get(CDS_PATH)!
    expect(cds).not.toContain('203.0.113.7')
    // The claim is dropped, so the pod lands on the outer proxy instead.
    expect(cds).toContain('10.96.0.50')
  })

  it('leaves every synced pod on the outer proxy when no claim exists', async () => {
    const h = harness({ routes: () => Promise.resolve(ROUTES) })
    h.setPods([SESSION_POD, INNER_PROXY, INNER_SESS])
    await reconcileOnce(h.deps, h.memo)
    expect(h.written.get(CDS_PATH)).not.toContain('10.244.0.31')
  })
})

describe('publishClaimOnce', () => {
  const CLAIM_CONFIG: NetdClaimConfig = { installNamespace: 'yaac', installHash: 'h1' }
  const PROXY_POD: NetdPod = {
    name: 'yaac-proxy-abc', namespace: 'yaac', podIp: '10.244.0.31', labels: { app: 'yaac-proxy' },
  }

  function claimHarness(pods: NetdPod[]): {
    deps: ClaimReconcileDeps
    memo: ClaimMemo
    published: string[]
  } {
    const published: string[] = []
    return {
      deps: {
        config: CLAIM_CONFIG,
        pods: () => pods,
        publish: (document) => { published.push(document); return Promise.resolve() },
        log: () => { /* quiet */ },
      },
      memo: {},
      published,
    }
  }

  it('claims this install\'s session pods for its own proxy pod IP', async () => {
    const h = claimHarness([PROXY_POD, SESSION_POD])
    const changed = await publishClaimOnce(h.deps, h.memo)
    expect(JSON.parse(h.published[0])).toEqual({
      install: 'h1', proxyPodIp: '10.244.0.31', sources: ['10.244.0.9'],
    })
    expect(changed[0]).toContain('1 pods -> 10.244.0.31')
  })

  it('never claims the proxy pod itself', async () => {
    const h = claimHarness([PROXY_POD, SESSION_POD])
    await publishClaimOnce(h.deps, h.memo)
    expect((JSON.parse(h.published[0]) as { sources: string[] }).sources)
      .not.toContain('10.244.0.31')
  })

  it('retracts (empty document) when no proxy pod is up', async () => {
    const h = claimHarness([SESSION_POD])
    await publishClaimOnce(h.deps, h.memo)
    expect(h.published).toEqual([''])
  })

  it('retracts when the install has no session pods', async () => {
    const h = claimHarness([PROXY_POD])
    await publishClaimOnce(h.deps, h.memo)
    expect(h.published).toEqual([''])
  })

  it('writes nothing when the claim is unchanged', async () => {
    const h = claimHarness([PROXY_POD, SESSION_POD])
    await publishClaimOnce(h.deps, h.memo)
    const changed = await publishClaimOnce(h.deps, h.memo)
    expect(changed).toEqual([])
    expect(h.published.length).toBe(1)
  })

  it('does not remember a failed publish', async () => {
    const h = claimHarness([PROXY_POD, SESSION_POD])
    h.deps.publish = () => Promise.reject(new Error('conflict'))
    await expect(publishClaimOnce(h.deps, h.memo)).rejects.toThrow('conflict')
    expect(h.memo.document).toBeUndefined()
  })
})
