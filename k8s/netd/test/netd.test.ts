import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CDS_PATH,
  LDS_PATH,
  type ConfirmListenersInput,
  type NetdConfig,
  type ReconcileDeps,
  type ReconcileMemo,
  loadConfig,
  reconcileOnce,
} from 'yaac-netd/netd'
import { ListenerRejectedError } from 'yaac-netd/envoy-admin'
import { redirectChainName } from 'yaac-netd/rules'
import type { NetdPod, NetdService } from 'yaac-netd/targets'

const ENV_KEYS = [
  'YAAC_NAMESPACE', 'NODE_NAME', 'NODE_IP', 'CLUSTER_POD_CIDRS', 'SSH_TUNNEL_SENTINEL',
  'TUNNEL_INGRESS_PORT', 'TRANSPARENT_HTTPS_PORT', 'TRANSPARENT_HTTP_PORT',
  'TRANSPARENT_TUNNEL_PORT', 'NETD_LISTENER_PORT_BASE', 'NETD_LISTENER_SLOTS',
  'NETD_VETH_PREFIX',
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

  it('takes the workload veth prefix from the env, defaulting to Calico\'s', () => {
    // Correct only where Calico does the IPAM; policy-only Calico over the
    // AWS VPC CNI gives `eni*`, which is why the server can override it.
    expect(loadConfig().vethPrefix).toBe('cali')
    process.env.NETD_VETH_PREFIX = 'eni'
    expect(loadConfig().vethPrefix).toBe('eni')
  })

  it('falls back to cali rather than honoring a prefix that would match everything', () => {
    // An empty prefix matches EVERY device in the routing table, which is
    // exactly the "redirect something that is not a workload" failure the
    // prefix exists to prevent — so a misconfiguration costs the cluster its
    // redirect (fail-closed) instead of widening it.
    for (const bad of ['', '   ', 'cali *', 'a/b']) {
      process.env.NETD_VETH_PREFIX = bad
      expect(loadConfig().vethPrefix).toBe('cali')
    }
  })
})

const CONFIG: NetdConfig = {
  installNamespace: 'yaac',
  nodeName: 'node-1',
  nodeIp: '10.89.0.7',
  podCidrs: ['10.244.0.0/16'],
  vethPrefix: 'cali',
  sshSentinelIp: '198.18.0.2',
  sshSentinelPort: 10259,
  transparentPorts: { https: 10256, http: 10257, tunnel: 10258 },
  listenerRange: { base: 15100, slots: 300 },
}

const PROXY_SVC: NetdService = {
  name: 'yaac-proxy', namespace: 'yaac', clusterIp: '10.96.0.50', labels: { app: 'yaac-proxy' },
}
const SESSION_POD: NetdPod = {
  name: 'sess-1', namespace: 'yaac', podIp: '10.244.0.9', labels: { 'yaac.worktree-id': 's1' },
}

interface Harness {
  deps: ReconcileDeps
  memo: ReconcileMemo
  calls: string[]
  written: Map<string, string>
  confirmed: ConfirmListenersInput[]
  setPods: (pods: NetdPod[]) => void
  setConfirm: (fn: (input: ConfirmListenersInput) => Promise<void>) => void
}

function harness(overrides: Partial<ReconcileDeps> = {}): Harness {
  const calls: string[] = []
  const written = new Map<string, string>()
  const confirmed: ConfirmListenersInput[] = []
  let pods: NetdPod[] = [SESSION_POD]
  let confirm: (input: ConfirmListenersInput) => Promise<void> = () => Promise.resolve()

  const deps: ReconcileDeps = {
    config: CONFIG,
    backend: 'legacy',
    chain: redirectChainName(CONFIG.installNamespace),
    pods: () => pods,
    services: () => [PROXY_SVC],
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
      name: 'sess-2', namespace: 'yaac', podIp: '10.244.0.10', labels: { 'yaac.worktree-id': 's2' },
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

  it('points every worktree pod at the one install trio', async () => {
    const h = harness()
    h.setPods([SESSION_POD, {
      name: 'sess-2',
      namespace: 'yaac',
      podIp: '10.244.0.20',
      labels: { 'yaac.worktree-id': 's2' },
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
