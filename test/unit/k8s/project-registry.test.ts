import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/k8s/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('@/lib/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  LABEL_REGISTRY_DATA_DIR_HASH,
  PROJECT_REGISTRY_PORT,
  REGISTRY_APP_LABEL,
  REGISTRY_IMAGE_DIGEST,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
  buildProjectRegistryDeploymentManifest,
  buildProjectRegistryServiceManifest,
  buildRegistryCleanupPodManifest,
  buildRegistryEgressNetworkPolicyManifest,
  buildRegistryHostsWriterPodManifest,
  buildRegistryIngressCnpManifest,
  buildRegistrySessionsNetworkPolicyManifest,
  ensureProjectRegistry,
  ensureRegistryImage,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  projectRegistryHostname,
  projectRegistryName,
  projectRegistryStorageHostPath,
  removeProjectRegistry,
} from '@/lib/k8s/project-registry'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { pushImageToRegistry, registryHasTag } from '@/lib/k8s/registry'
import { imageExists } from '@/lib/container/runtime'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const NODE_LIST = { items: [{ metadata: { name: 'yaac-control-plane' } }] }

beforeEach(() => {
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockExec.mockReset()
  mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  mockHasTag.mockReset()
  mockHasTag.mockResolvedValue(false)
  mockPush.mockReset()
  mockPush.mockImplementation((tag: string) => Promise.resolve(`localhost:5001/${tag}`))
  mockImageExists.mockReset()
  mockImageExists.mockResolvedValue(false)
})

describe('projectRegistryName', () => {
  it('is deterministic with the yaac-reg prefix and an 8-char hash suffix', () => {
    const name = projectRegistryName('demo')
    expect(name).toBe(projectRegistryName('demo'))
    expect(name).toMatch(/^yaac-reg-demo-[0-9a-f]{8}$/)
  })

  it('truncates long slugs but keeps them unique via the full-slug hash', () => {
    const a = projectRegistryName('a'.repeat(30) + '-one')
    const b = projectRegistryName('a'.repeat(30) + '-two')
    expect(a).not.toBe(b)
    // DNS-label cap: prefix(9) + slug(≤21) + dash(1) + hash(8) ≤ 39.
    expect(a.length).toBeLessThanOrEqual(39)
    expect(a.length).toBeLessThanOrEqual(63)
  })

  it('sanitizes slugs into DNS-safe names', () => {
    expect(projectRegistryName('My_Project!')).toMatch(/^yaac-reg-my-project-[0-9a-f]{8}$/)
  })
})

describe('host / VIP / storage helpers', () => {
  it('builds the registry svc-DNS host as a full .cluster.local FQDN', () => {
    const name = projectRegistryName('demo')
    // FQDN, not the `.svc` shorthand: the proxy forwards only `.cluster.local`.
    expect(projectRegistryHostname('demo')).toBe(`${name}.test-ns.svc.cluster.local`)
    expect(projectRegistryHost('demo')).toBe(`${name}.test-ns.svc.cluster.local:${PROJECT_REGISTRY_PORT}`)
  })

  it('scopes node-local storage by install hash and project slug', () => {
    expect(projectRegistryStorageHostPath('demo')).toBe('/var/lib/yaac/registry/ddh16/demo')
  })

  it('renders an insecure drop-in scoped to the exact registry host', () => {
    const conf = projectRegistryConfDropIn('demo')
    expect(conf).toBe([
      '[[registry]]',
      `location = "${projectRegistryHost('demo')}"`,
      'insecure = true',
      '',
    ].join('\n'))
  })
})

describe('manifest builders', () => {
  interface Deployment {
    kind: string
    metadata: { name: string; namespace: string; labels: Record<string, string> }
    spec: {
      replicas: number
      strategy: { type: string }
      selector: { matchLabels: Record<string, string> }
      template: {
        metadata: { labels: Record<string, string> }
        spec: {
          automountServiceAccountToken: boolean
          enableServiceLinks: boolean
          hostUsers?: boolean
          securityContext?: object
          containers: Array<{
            image: string
            ports: Array<{ containerPort: number }>
            readinessProbe: { httpGet: { path: string; port: number } }
            volumeMounts: Array<{ name: string; mountPath: string }>
          }>
          volumes: Array<{ name: string; hostPath: { path: string; type: string } }>
        }
      }
    }
  }

  it('builds a single-replica Recreate Deployment storing into the node-local hostPath', () => {
    const m = buildProjectRegistryDeploymentManifest(
      'demo', 'localhost:5001/yaac-registry2:abc',
    ) as unknown as Deployment
    expect(m.kind).toBe('Deployment')
    expect(m.metadata.name).toBe(projectRegistryName('demo'))
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.metadata.labels).toEqual({
      app: REGISTRY_APP_LABEL,
      'yaac.project': 'demo',
      [LABEL_REGISTRY_DATA_DIR_HASH]: 'ddh16',
    })
    expect(m.spec.replicas).toBe(1)
    expect(m.spec.strategy).toEqual({ type: 'Recreate' })
    expect(m.spec.selector.matchLabels).toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' })

    const spec = m.spec.template.spec
    expect(spec.automountServiceAccountToken).toBe(false)
    expect(spec.enableServiceLinks).toBe(false)
    // Trusted infra, like the proxy: plain root, no hostUsers branch.
    expect(spec.hostUsers).toBeUndefined()
    expect(spec.securityContext).toBeUndefined()
    expect(spec.containers[0].image).toBe('localhost:5001/yaac-registry2:abc')
    expect(spec.containers[0].ports).toEqual([{ containerPort: PROJECT_REGISTRY_PORT }])
    expect(spec.containers[0].readinessProbe.httpGet)
      .toEqual({ path: '/v2/', port: PROJECT_REGISTRY_PORT })
    expect(spec.containers[0].volumeMounts)
      .toEqual([{ name: 'storage', mountPath: '/var/lib/registry' }])
    expect(spec.volumes).toEqual([{
      name: 'storage',
      hostPath: { path: '/var/lib/yaac/registry/ddh16/demo', type: 'DirectoryOrCreate' },
    }])
  })

  it('builds a pinned-VIP ClusterIP Service with port == targetPort', () => {
    expect(buildProjectRegistryServiceManifest('demo')).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: projectRegistryName('demo'),
        namespace: 'test-ns',
        labels: {
          app: REGISTRY_APP_LABEL,
          'yaac.project': 'demo',
          [LABEL_REGISTRY_DATA_DIR_HASH]: 'ddh16',
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: { app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' },
        ports: [{
          name: 'registry',
          port: PROJECT_REGISTRY_PORT,
          targetPort: PROJECT_REGISTRY_PORT,
        }],
      },
    })
  })

  it('admits only this project\'s sessions to this project\'s registry', () => {
    const m = buildRegistrySessionsNetworkPolicyManifest('demo') as unknown as {
      metadata: { name: string }
      spec: {
        podSelector: {
          matchLabels: Record<string, string>
          matchExpressions: Array<{ key: string; operator: string }>
        }
        policyTypes: string[]
        egress: Array<{
          to: Array<{ podSelector: { matchLabels: Record<string, string> } }>
          ports: Array<{ protocol: string; port: number }>
        }>
      }
    }
    expect(m.metadata.name).toBe(`${projectRegistryName('demo')}-sessions`)
    // The Exists term keeps the policy off the registry pod itself.
    expect(m.spec.podSelector.matchLabels).toEqual({ 'yaac.project': 'demo' })
    expect(m.spec.podSelector.matchExpressions)
      .toEqual([{ key: 'yaac.session-id', operator: 'Exists' }])
    expect(m.spec.policyTypes).toEqual(['Egress'])
    expect(m.spec.egress).toEqual([{
      to: [{
        podSelector: {
          matchLabels: { app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' },
        },
      }],
      ports: [{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }],
    }])
  })

  it('locks registry ingress to same-project sessions and the node (host/remote-node)', () => {
    const m = buildRegistryIngressCnpManifest('demo') as unknown as {
      apiVersion: string
      kind: string
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        endpointSelector: { matchLabels: Record<string, string> }
        ingress: Array<{
          fromEndpoints?: Array<{
            matchLabels: Record<string, string>
            matchExpressions: Array<{ key: string; operator: string }>
          }>
          fromEntities?: string[]
          toPorts: Array<{ ports: Array<{ port: string; protocol: string }> }>
        }>
      }
    }
    expect(m.apiVersion).toBe('cilium.io/v2')
    expect(m.kind).toBe('CiliumNetworkPolicy')
    expect(m.metadata.name).toBe(`${projectRegistryName('demo')}-ingress`)
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.spec.endpointSelector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' })

    const [sessions, node] = m.spec.ingress
    // Same-project sessions only — the receiving-side half of the
    // cross-project lock (the sessions NetworkPolicy is the egress half).
    expect(sessions.fromEndpoints).toEqual([{
      matchLabels: { 'yaac.project': 'demo' },
      matchExpressions: [{ key: 'yaac.session-id', operator: 'Exists' }],
    }])
    expect(sessions.toPorts[0].ports)
      .toEqual([{ port: String(PROJECT_REGISTRY_PORT), protocol: 'TCP' }])
    // Kubelet probes and node containerd pulls arrive from the host netns.
    expect(node.fromEntities).toEqual(['host', 'remote-node'])
    expect(node.toPorts[0].ports)
      .toEqual([{ port: String(PROJECT_REGISTRY_PORT), protocol: 'TCP' }])
  })

  it('denies all registry-pod egress (nothing to fetch)', () => {
    const m = buildRegistryEgressNetworkPolicyManifest('demo') as unknown as {
      metadata: { name: string }
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        egress: unknown[]
      }
    }
    expect(m.metadata.name).toBe(`${projectRegistryName('demo')}-egress`)
    expect(m.spec.podSelector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' })
    expect(m.spec.policyTypes).toEqual(['Egress'])
    expect(m.spec.egress).toEqual([])
  })
})

describe('node-write pod builders', () => {
  interface Pod {
    kind: string
    metadata: { name: string; namespace: string; labels: Record<string, string> }
    spec: {
      nodeName: string
      restartPolicy: string
      automountServiceAccountToken: boolean
      enableServiceLinks: boolean
      hostUsers?: boolean
      securityContext?: object
      containers: Array<{
        image: string
        command: string[]
        volumeMounts: Array<{ name: string; mountPath: string }>
      }>
      volumes: Array<{ name: string; hostPath: { path: string; type: string } }>
    }
  }

  it('writer pod pins the node and mounts only this registry\'s certs.d dir', () => {
    const m = buildRegistryHostsWriterPodManifest(
      'demo', 'localhost:5001/yaac-registry2:abc', 'yaac-control-plane', '10.96.0.50', 0,
    ) as unknown as Pod
    expect(m.kind).toBe('Pod')
    expect(m.metadata.name).toBe(`${projectRegistryName('demo')}-hosts-0`)
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.metadata.labels).toEqual({
      app: REGISTRY_APP_LABEL,
      'yaac.project': 'demo',
      [LABEL_REGISTRY_DATA_DIR_HASH]: 'ddh16',
    })
    // nodeName bypasses the scheduler — exact parity with the old
    // every-node podman-exec loop, taints cannot strand the pod.
    expect(m.spec.nodeName).toBe('yaac-control-plane')
    expect(m.spec.restartPolicy).toBe('Never')
    expect(m.spec.automountServiceAccountToken).toBe(false)
    expect(m.spec.enableServiceLinks).toBe(false)
    // Trusted infra, like the registry itself: plain root, no hostUsers.
    expect(m.spec.hostUsers).toBeUndefined()
    expect(m.spec.securityContext).toBeUndefined()
    expect(m.spec.containers[0].image).toBe('localhost:5001/yaac-registry2:abc')
    const script = m.spec.containers[0].command[2]
    expect(script).toContain(`[host."http://10.96.0.50:${PROJECT_REGISTRY_PORT}"]`)
    expect(script).toContain('/host-certs/hosts.toml')
    // Mount scoped to exactly this registry's certs.d dir; DirectoryOrCreate
    // replaces the old mkdir -p.
    expect(m.spec.volumes).toEqual([{
      name: 'certs',
      hostPath: {
        path: `/etc/containerd/certs.d/${projectRegistryHost('demo')}`,
        type: 'DirectoryOrCreate',
      },
    }])
    expect(m.spec.containers[0].volumeMounts)
      .toEqual([{ name: 'certs', mountPath: '/host-certs' }])
  })

  it('cleanup pod mounts the parents and removes both residue dirs', () => {
    const m = buildRegistryCleanupPodManifest(
      'demo', 'localhost:5001/yaac-registry2:abc', 'yaac-control-plane', 0,
    ) as unknown as Pod
    expect(m.metadata.name).toBe(`${projectRegistryName('demo')}-cleanup-0`)
    expect(m.spec.nodeName).toBe('yaac-control-plane')
    // Parent mounts: removing the child dirs themselves (today's residue
    // semantics) is impossible from inside a mount of the child.
    expect(m.spec.volumes).toEqual([
      { name: 'certs', hostPath: { path: '/etc/containerd/certs.d', type: 'DirectoryOrCreate' } },
      { name: 'storage', hostPath: { path: '/var/lib/yaac/registry/ddh16', type: 'DirectoryOrCreate' } },
    ])
    const script = m.spec.containers[0].command[2]
    expect(script).toBe(
      `rm -rf '/host-certs/${projectRegistryHost('demo')}' '/host-storage/demo'`,
    )
  })
})

describe('ensureRegistryImage', () => {
  it('pins the upstream by its multi-arch index digest', () => {
    expect(REGISTRY_UPSTREAM_IMAGE).toBe(`docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`)
    expect(REGISTRY_MIRROR_TAG).toBe(`yaac-registry2:${REGISTRY_IMAGE_DIGEST.slice(7, 19)}`)
  })

  it('short-circuits when the registry already holds the mirror tag', async () => {
    mockHasTag.mockResolvedValue(true)
    await expect(ensureRegistryImage(false))
      .resolves.toBe(`localhost:5001/${REGISTRY_MIRROR_TAG}`)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('pushes a locally present mirror without pulling', async () => {
    mockImageExists.mockResolvedValue(true)
    await ensureRegistryImage(false)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)
  })

  it('pulls by digest and tags the mirror when absent', async () => {
    await ensureRegistryImage(false)
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['pull', REGISTRY_UPSTREAM_IMAGE], expect.objectContaining({ timeout: 300_000 }),
    )
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['tag', REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG],
    )
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)
  })

  it('fails fast under requirePrebuilt instead of pulling', async () => {
    await expect(ensureRegistryImage(true)).rejects.toThrow(/missing/)
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('ensureProjectRegistry', () => {
  beforeEach(() => {
    mockHasTag.mockResolvedValue(true)
    // get service → live (allocator-assigned) ClusterIP; get nodes → one
    // node; get pod → the writer pod completed.
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })
  })

  it('applies Deployment, Service, and all network policies, then waits and runs the hosts-writer pod', async () => {
    await ensureProjectRegistry('demo')

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'Deployment', 'Service', 'NetworkPolicy', 'CiliumNetworkPolicy', 'NetworkPolicy', 'Pod',
    ])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${projectRegistryName('demo')}`,
        '-n', 'test-ns', '--timeout=120s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    // hosts.toml written by an in-cluster one-shot pod pinned to the node,
    // NOT podman exec — the server's engine need not host the node.
    const pod = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`http://10.96.0.50:${PROJECT_REGISTRY_PORT}`)
    expect(mockExec).not.toHaveBeenCalled()
    // The writer pod is pre-cleaned and deleted after completion.
    expect(mockRetry).toHaveBeenCalledWith(
      ['delete', 'pod', `${projectRegistryName('demo')}-hosts-0`, '-n', 'test-ns', '--ignore-not-found'],
    )
    // The ClusterIP is allocator-assigned and never deleted — no migration.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })

  it('surfaces a failed writer pod with its logs (session create must not proceed)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'read-only file system\n' : '', stderr: '' }))

    await expect(ensureProjectRegistry('demo'))
      .rejects.toThrow(/did not complete \(phase Failed\); logs: read-only file system/)
  })
})

describe('removeProjectRegistry', () => {
  function mockClusterWithPodPhase(phase: string, hadRegistry = true): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'deployment,service') {
        return Promise.resolve({ items: hadRegistry ? [{}] : [] })
      }
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase } })
      return Promise.resolve(null)
    })
  }

  it('deletes by label selector scoped to this install and cleans the node via a pod', async () => {
    mockClusterWithPodPhase('Succeeded')
    await removeProjectRegistry('demo')
    // `pod` in the kinds reaps stray writer/cleanup pods from crashed runs.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,ciliumnetworkpolicy,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    const pod = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`/host-certs/${projectRegistryHost('demo')}`)
    expect(script).toContain('/host-storage/demo')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('swallows node-side cleanup failures (cluster recreate)', async () => {
    mockClusterWithPodPhase('Failed')
    await expect(removeProjectRegistry('demo')).resolves.toBeUndefined()
  })

  it('skips the node cleanup pods when the project never had a registry', async () => {
    mockClusterWithPodPhase('Succeeded', false)
    await removeProjectRegistry('demo')
    // The by-selector delete still runs (reaps stray pods from crashes)...
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,ciliumnetworkpolicy,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    // ...but no cleanup pod is applied and no nodes are listed: a pod that
    // can't start (image never mirrored / nested pod guard) would burn the
    // full runNodeWritePod deadline and stall project remove for 60s.
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockGetJson).not.toHaveBeenCalledWith(['get', 'nodes'])
  })
})

describe('gcOrphanProjectRegistries', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('removes registries whose project dir is gone, keeps live ones', async () => {
    await fs.mkdir(path.join(tmpDir, 'projects', 'alive'), { recursive: true })
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'services') {
        return Promise.resolve({
          items: [
            { metadata: { labels: { 'yaac.project': 'alive' } } },
            { metadata: { labels: { 'yaac.project': 'gone' } } },
          ],
        })
      }
      if (args[1] === 'deployment,service') return Promise.resolve({ items: [{}] })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })

    await gcOrphanProjectRegistries()

    // Filter to the label-selector object deletes — the cleanup pod's own
    // lifecycle (pre-delete + delete-after) also issues `delete pod` calls.
    const deletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'deployment,service,networkpolicy,ciliumnetworkpolicy,pod')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][3]).toContain('yaac.project=gone')
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(gcOrphanProjectRegistries()).resolves.toBeUndefined()
  })
})
