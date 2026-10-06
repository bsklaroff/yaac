import { describe, it, expect, vi, beforeEach } from 'vitest'

// The cluster (the fake behind client-node) is the boundary. The cluster
// folder runs for real behind it, including the hosts.toml writer pods
// `runOnEachNode` drives.

// The registry client answers over HTTP, which a unit run does not have.
vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  REGISTRY_SERVICE_NAME: 'yaac-registry',
  REGISTRY_SERVICE_PORT: 5000,
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
}))

import { reconcileNodeSet } from '#drivers/k8s/cluster'
// Test hooks, not units under test.
import { _nodeSyncSettledForTests, _resetNodeSyncForTests } from '#drivers/k8s/cluster/node-sync'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { projectRegistryName } from '#drivers/k8s/cluster/project-registry'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

interface Applied {
  kind: string
  metadata: { name: string }
  spec?: {
    nodeName?: string
    ingress?: Array<{ from?: Array<{ ipBlock?: { cidr: string } }> }>
    volumes?: Array<{ hostPath?: { path: string } }>
  }
}

interface FakeNode { ip: string; uid: string; ready: boolean }

const PROJECTS = ['p1', 'p2']

/** The cluster's nodes by name, and which nodes' writer pods fail. */
let nodes: Record<string, FakeNode> = {}
let failingNodes = new Set<string>()

/**
 * Stage the cluster: the nodes, the main registry's Service and p1's (p2 has
 * no registry), plus what the API server fills in on read: each Service's
 * ClusterIP and each writer pod's terminal phase.
 */
function serveCluster(): void {
  fakeCluster.reset()
  seedNodes()
  fakeCluster.seed(
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'yaac-registry', namespace: 'yaac' }, spec: { clusterIP: '10.96.0.50' } },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: projectRegistryName('p1'), namespace: 'test-ns' }, spec: { clusterIP: '10.96.0.61' },
    },
  )
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || call.kind !== 'Pod' || !call.name) return
    const pod = fakeCluster.get<Applied>('Pod', call.name, call.namespace)
    if (!pod) return
    return { ...pod, status: { phase: failingNodes.has(pod.spec?.nodeName ?? '') ? 'Failed' : 'Succeeded' } }
  })
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
      addresses: [{ type: 'InternalIP', address: n.ip }],
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
  await reconcileNodeSet(PROJECTS)
  await _nodeSyncSettledForTests()
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  _resetNodeSyncForTests()
  resetClusterCidrCache()
  nodes = { 'node-a': { ip: '10.0.1.5', uid: 'u-a', ready: true } }
  failingNodes = new Set()
  serveCluster()
})

describe('reconcileNodeSet', () => {
  it('admits a joining node at once, and writes its registry hosts once it is Ready', async () => {
    await pass()
    // Every node-address policy admits the node, and its containerd learns
    // the main registry and each registry a project has (p2 has none).
    for (const policy of ['yaac-server-ingress', 'yaac-proxy-ingress', 'yaac-npm-cache-ingress', 'yaac-registry-ingress']) {
      expect(admittedNodes(policy), policy).toEqual(['10.0.1.5/32'])
    }
    expect(applied().map((m) => m.metadata.name)).toEqual(expect.arrayContaining([
      'yaac-workspace-egress', 'yaac-proxy-egress', 'yaac-npm-cache-egress',
    ]))
    expect(hostsWrites()).toEqual([
      'node-a yaac-registry.yaac.svc.cluster.local:5000',
      expect.stringMatching(/^node-a .*p1.*:5000$/) as string,
    ])

    // Nothing changed: no writes at all.
    clearCalls()
    await pass()
    expect(applied()).toEqual([])

    // An autoscaled node registers: the policies admit it straight away, but
    // its writer pods wait until it is Ready.
    nodes['node-b'] = { ip: '10.0.2.9', uid: 'u-b', ready: false }
    await pass()
    expect(admittedNodes('yaac-registry-ingress')).toEqual(['10.0.1.5/32', '10.0.2.9/32'])
    expect(admittedNodes('yaac-server-ingress')).toEqual(['10.0.1.5/32', '10.0.2.9/32'])
    expect(hostsWrites()).toEqual([])

    // Ready: only the new node gets writer pods.
    nodes['node-b'].ready = true
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-b', 'node-b'])
    expect(applied().some((m) => m.kind === 'NetworkPolicy')).toBe(false)
  })

  it('writes to a replacement node that reuses a departed node\'s name and address', async () => {
    await pass()
    // EKS names nodes after their private address, which the subnet hands
    // out again: the set of addresses is unchanged, the node is not.
    nodes['node-a'] = { ip: '10.0.1.5', uid: 'u-a2', ready: true }
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-a', 'node-a'])
  })

  it('never fails or holds up the pass for a node that cannot run pods, and retries it later', async () => {
    nodes['node-b'] = { ip: '10.0.2.9', uid: 'u-b', ready: true }
    failingNodes = new Set(['node-b'])
    seedNodes()
    await expect(reconcileNodeSet(PROJECTS)).resolves.toBeUndefined()
    await _nodeSyncSettledForTests()
    // The healthy node is done; the broken one is not recorded as done.
    failingNodes = new Set()
    clearCalls()
    await pass()
    expect(hostsWrites().map((w) => w.split(' ')[0])).toEqual(['node-b', 'node-b'])
  })
})
