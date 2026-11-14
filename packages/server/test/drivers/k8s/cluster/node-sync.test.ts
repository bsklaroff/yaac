import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'

// The cluster (the fake behind client-node) and the registry (holding every
// mirrored image) are the boundaries. The cluster folder runs for real
// behind them, including the hosts.toml writer pods `runOnEachNode` drives.

import { reconcileNodeSet } from '#drivers/k8s/cluster'
// Test hooks, not units under test.
import { _nodeSyncSettledForTests, _resetNodeSyncForTests } from '#drivers/k8s/cluster/node-sync'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

interface Applied {
  kind: string
  metadata: { name: string }
  spec?: {
    nodeName?: string
    ingress?: Array<{ from?: Array<{ ipBlock?: { cidr: string } }> }>
    egress?: Array<{ to?: Array<{ ipBlock?: { cidr: string; except?: string[] } }>; ports?: Array<{ port: number }> }>
    volumes?: Array<{ hostPath?: { path: string } }>
  }
}

interface FakeNode { ip: string; externalIp?: string; uid: string; ready: boolean }

/** The cluster's nodes by name, and which nodes' writer pods fail. */
let nodes: Record<string, FakeNode> = {}
let failingNodes = new Set<string>()

/**
 * Stage the cluster: the nodes and the main registry's Service, plus what
 * the API server fills in on read: each Service's
 * ClusterIP and each writer pod's terminal phase.
 */
function serveCluster(): void {
  fakeCluster.reset()
  seedNodes()
  fakeCluster.seed(
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'yaac-registry', namespace: 'yaac' }, spec: { clusterIP: '10.96.0.50' } },
  )
  seedApiserver('172.20.0.10')
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Service', metadata: { name: 'kube-dns', namespace: 'kube-system' },
    spec: { clusterIP: '10.96.0.10', clusterIPs: ['10.96.0.10'] },
  })
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || call.kind !== 'Pod' || !call.name) return
    const pod = fakeCluster.get<Applied>('Pod', call.name, call.namespace)
    if (!pod) return
    return { ...pod, status: { phase: failingNodes.has(pod.spec?.nodeName ?? '') ? 'Failed' : 'Succeeded' } }
  })
}

/** The `kubernetes` Service's EndpointSlice: a managed control plane off the nodes. */
function seedApiserver(address: string): void {
  fakeCluster.seed({
    apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice',
    metadata: { name: 'kubernetes', namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
    addressType: 'IPv4', endpoints: [{ addresses: [address] }], ports: [{ name: 'https', port: 443 }],
  })
}

/** The addresses an egress policy names on `port`, in the last apply of it. */
function egressPeers(port: number, policy = 'yaac-proxy-egress'): string[] {
  const np = applied().filter((m) => m.kind === 'NetworkPolicy' && m.metadata.name === policy).pop()
  return (np?.spec?.egress ?? []).filter((r) => r.ports?.some((p) => p.port === port))
    .flatMap((r) => r.to ?? []).flatMap((t) => (t.ipBlock ? [t.ipBlock.cidr] : []))
}

/** What the builders' public IPv4 block cuts, in the last apply of their policy. */
function builderExcepts(): string[] {
  const np = applied().filter((m) => m.kind === 'NetworkPolicy' && m.metadata.name === 'yaac-builder-egress').pop()
  return np?.spec?.egress?.[0].to?.[0].ipBlock?.except ?? []
}

/** (Re)seed the Node objects from `nodes`, replacing any removed one. */
function seedNodes(): void {
  for (const node of fakeCluster.objects<{ metadata: { name: string } }>('Node')) {
    if (!(node.metadata.name in nodes)) fakeCluster.request({ verb: 'delete', apiVersion: 'v1', kind: 'Node', name: node.metadata.name })
  }
  fakeCluster.seed(...Object.entries(nodes).map(([name, n]) => ({
    apiVersion: 'v1', kind: 'Node',
    metadata: { name, uid: n.uid },
    status: {
      addresses: [
        { type: 'InternalIP', address: n.ip },
        ...(n.externalIp ? [{ type: 'ExternalIP', address: n.externalIp }] : []),
      ],
      conditions: [{ type: 'Ready', status: n.ready ? 'True' : 'False' }],
    },
  })))
}

function applied(): Applied[] {
  return fakeCluster.callsOf('apply').map((c) => c.body as unknown as Applied)
}

/** Every hosts.toml writer pod: the node it ran on and the registry host it wrote. */
function hostsWrites(): string[] {
  return applied()
    .filter((m) => m.kind === 'Pod' && m.metadata.name.includes('-hosts-'))
    .map((m) => `${m.spec!.nodeName!} ${m.spec!.volumes![0].hostPath!.path.split('/').pop()!}`)
}

/** The node addresses a policy admits by ipBlock, in the last apply of it. */
function admittedNodes(policy: string): string[] {
  const np = applied().filter((m) => m.kind === 'NetworkPolicy' && m.metadata.name === policy).pop()
  return (np?.spec?.ingress ?? []).flatMap((r) => r.from ?? []).flatMap((f) => (f.ipBlock ? [f.ipBlock.cidr] : []))
}

/** Forget the calls so far, so the next assertions see only the next pass. */
function clearCalls(): void {
  fakeCluster.calls.length = 0
}

async function pass(): Promise<void> {
  seedNodes()
  await reconcileNodeSet()
  await _nodeSyncSettledForTests()
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  fakeRegistry.install()
  fakeRegistry.holdsAll = true
  _resetNodeSyncForTests()
  resetClusterCidrCache()
  nodes = { 'node-a': { ip: '10.0.1.5', uid: 'u-a', ready: true } }
  failingNodes = new Set()
  serveCluster()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('reconcileNodeSet', () => {
  it('admits a joining node at once, and writes its registry hosts once it is Ready', async () => {
    await pass()
    // Every node-address policy admits the node, and its containerd learns
    // the main registry.
    for (const policy of [
      'yaac-server-ingress', 'yaac-proxy-ingress', 'yaac-npm-cache-ingress', 'yaac-registry-ingress',
      'yaac-site-tunnel-cloudflare-ingress', 'yaac-site-tunnel-tailnet-ingress', 'yaac-site-router-ingress',
    ]) {
      expect(admittedNodes(policy), policy).toEqual(['10.0.1.5/32'])
    }
    expect(applied().map((m) => m.metadata.name)).toEqual(expect.arrayContaining([
      'yaac-workspace-egress', 'yaac-proxy-egress', 'yaac-npm-cache-egress', 'yaac-site-tunnel-cloudflare-egress',
      'yaac-site-tunnel-tailnet-egress',
    ]))
    expect(hostsWrites()).toEqual(['node-a yaac-registry.yaac.svc.cluster.local:5000'])
    // The apiserver at its real endpoint, and DNS at the kube-dns Service.
    expect(egressPeers(443)).toEqual(['172.20.0.10/32'])
    expect(egressPeers(53)).toEqual(['10.96.0.10/32', '169.254.0.0/16'])
    // The server's own egress names the same apiserver, and no Tor listener
    // when Tor is off.
    expect(egressPeers(443, 'yaac-server-egress')).toEqual(['172.20.0.10/32'])
    expect(egressPeers(9050, 'yaac-server-egress')).toEqual([])

    // Nothing changed: no writes at all.
    clearCalls()
    await pass()
    expect(applied()).toEqual([])

    // An autoscaled node registers: the policies admit it straight away, but
    // its writer pods wait until it is Ready. A builder that waited for it
    // must not reach it through its public address, so the builders' policy
    // cuts that too, though only InternalIPs are admitted.
    nodes['node-b'] = { ip: '10.0.2.9', externalIp: '5.75.1.9', uid: 'u-b', ready: false }
    await pass()
    expect(admittedNodes('yaac-registry-ingress')).toEqual(['10.0.1.5/32', '10.0.2.9/32'])
    expect(admittedNodes('yaac-server-ingress')).toEqual(['10.0.1.5/32', '10.0.2.9/32'])
    expect(builderExcepts()).toEqual(expect.arrayContaining(['5.75.1.9/32', '10.0.2.9/32']))
    expect(hostsWrites()).toEqual([])

    // Ready: only the new node gets a writer pod.
    nodes['node-b'].ready = true
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-b'])
    expect(applied().some((m) => m.kind === 'NetworkPolicy')).toBe(false)

    // The proxy's watches and the server's own calls follow the apiserver's
    // endpoint when it moves.
    seedApiserver('172.20.0.11')
    await pass()
    expect(egressPeers(443)).toEqual(['172.20.0.11/32'])
    expect(egressPeers(443, 'yaac-server-egress')).toEqual(['172.20.0.11/32'])
  })

  // A single apiserver drops its own endpoint while it restarts. The server's
  // egress keeps its last good apiserver rule, and the rest still renders.
  it('renders every other policy while the apiserver\'s endpoints read empty, then the server\'s once they return', async () => {
    fakeCluster.request({ verb: 'delete', apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', name: 'kubernetes', namespace: 'default' })
    await pass()
    expect(admittedNodes('yaac-server-ingress')).toEqual(['10.0.1.5/32'])
    expect(admittedNodes('yaac-registry-ingress')).toEqual(['10.0.1.5/32'])
    expect(applied().map((m) => m.metadata.name)).not.toContain('yaac-server-egress')

    // Nothing else changed, but the server's egress is still due.
    seedApiserver('172.20.0.10')
    clearCalls()
    await pass()
    expect(egressPeers(443, 'yaac-server-egress')).toEqual(['172.20.0.10/32'])
  })

  it('opens the server\'s egress to the host Tor listener its pod was handed', async () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    vi.stubEnv('YAAC_HOST_TOR_SOCKS_URL', 'socks5h://172.18.0.1:9050')
    await pass()
    expect(egressPeers(9050, 'yaac-server-egress')).toEqual(['172.18.0.1/32'])
  })

  it('writes to a replacement node that reuses a departed node\'s name and address', async () => {
    await pass()
    // EKS names nodes after their private address, which the subnet hands
    // out again: the set of addresses is unchanged, the node is not.
    nodes['node-a'] = { ip: '10.0.1.5', uid: 'u-a2', ready: true }
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-a'])
  })

  it('never fails or holds up the pass for a node that cannot run pods, and retries it later', async () => {
    nodes['node-b'] = { ip: '10.0.2.9', uid: 'u-b', ready: true }
    failingNodes = new Set(['node-b'])
    seedNodes()
    await expect(reconcileNodeSet()).resolves.toBeUndefined()
    await _nodeSyncSettledForTests()
    // The healthy node is done; the broken one is not recorded as done.
    failingNodes = new Set()
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-b'])
  })
})
