import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as childProcess from 'node:child_process'

// The boundaries the main registry's ensure meets, as in
// main-registry.test.ts: kubectl (`rollout status`), the port-forward the
// registry client dials through, and the node-CIDR probe.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: unknown, res?: object) => void) => {
    process.nextTick(() => { cb(null, { stdout: '', stderr: '' }) })
  },
  spawn: () => {
    const pipe = (): EventEmitter => Object.assign(new EventEmitter(), { unref: () => {} })
    const child = Object.assign(new EventEmitter(), { stdout: pipe(), stderr: pipe(), unref: () => {}, kill: () => {} })
    process.nextTick(() => child.stdout.emit('data', Buffer.from('Forwarding from 127.0.0.1:41234 -> 5000\n')))
    return child
  },
}))
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
}))

import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { REGISTRY_NAMESPACE, ensureMainRegistry, sweepProjectRegistries } from '#drivers/k8s/cluster'
import { LABEL_INSTALL_ID, installId, k8sNamespace } from '#drivers/k8s/substrate'
// State-reset hook, not a unit under test.
import { _resetPortForwardsForTests } from '#drivers/k8s/substrate/port-forward'

const KINDS = [
  ['apps/v1', 'Deployment'],
  ['v1', 'Service'],
  ['networking.k8s.io/v1', 'NetworkPolicy'],
  ['v1', 'Pod'],
  ['v1', 'PersistentVolumeClaim'],
] as const

/** One object of each kind a project registry was made of. */
function seedRegistry(name: string, labels: Record<string, string>, namespace = k8sNamespace()): void {
  for (const [apiVersion, kind] of KINDS) {
    fakeCluster.seed({ apiVersion, kind, metadata: { name, namespace, labels } })
  }
}

beforeEach(() => {
  fakeCluster.reset()
  _resetPortForwardsForTests()
})

afterEach(() => {
  _resetPortForwardsForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('sweepProjectRegistries', () => {
  it('deletes every object of this install\'s project registries, and nothing else', async () => {
    const ours = { app: 'yaac-registry', [LABEL_INSTALL_ID]: installId(), 'yaac.project-id': 'p1' }
    seedRegistry('yaac-reg-p1', ours)
    // Another install's registry in the same namespace stays.
    seedRegistry('yaac-reg-other', { ...ours, [LABEL_INSTALL_ID]: 'another-install' })

    await sweepProjectRegistries()

    for (const [, kind] of KINDS) {
      expect(fakeCluster.get(kind, 'yaac-reg-p1', k8sNamespace()), kind).toBeUndefined()
      expect(fakeCluster.get(kind, 'yaac-reg-other', k8sNamespace()), kind).toBeDefined()
    }
    // The claim goes last, after the pods that hold it.
    expect(fakeCluster.callsOf('delete').map((c) => c.kind).at(-1)).toBe('PersistentVolumeClaim')

    // A pass with nothing left deletes nothing more.
    const deletes = fakeCluster.callsOf('delete').length
    await sweepProjectRegistries()
    expect(fakeCluster.callsOf('delete')).toHaveLength(deletes)
  })

  // A default install keeps the main registry in its own namespace, so the
  // sweep must not match anything the real ensure creates.
  it('leaves the main registry it shares a namespace with alone', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', REGISTRY_NAMESPACE)
    fakeCluster.seed({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'yaac-control-plane' } })
    // What the API server fills in on read: the Service's ClusterIP, and a
    // hosts.toml writer pod's terminal phase.
    fakeCluster.intercept((call) => {
      if (call.verb !== 'read' || !call.name) return
      const stored = fakeCluster.get<Record<string, unknown>>(call.kind, call.name, call.namespace)
      if (!stored) return
      if (call.kind === 'Service') fakeCluster.seed({ ...stored, spec: { ...stored.spec as object, clusterIP: '10.96.12.34' } } as never)
      if (call.kind === 'Pod') fakeCluster.seed({ ...stored, status: { phase: 'Succeeded' } } as never)
    })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })))
    await ensureMainRegistry({ force: true })
    // Its serving pod, as the ReplicaSet creates it from the template.
    const deploy = fakeCluster.get<{ spec: { template: { metadata: { labels: Record<string, string> } } } }>(
      'Deployment', 'yaac-registry', REGISTRY_NAMESPACE)
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'yaac-registry-abc12', namespace: REGISTRY_NAMESPACE, labels: deploy!.spec.template.metadata.labels },
    })
    const deletes = fakeCluster.callsOf('delete').length

    await sweepProjectRegistries()

    expect(fakeCluster.callsOf('delete')).toHaveLength(deletes)
    expect(fakeCluster.get('Pod', 'yaac-registry-abc12', REGISTRY_NAMESPACE)).toBeDefined()
  })
})
