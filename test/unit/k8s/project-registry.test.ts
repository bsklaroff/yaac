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
  buildRegistryEgressNetworkPolicyManifest,
  buildRegistrySessionsNetworkPolicyManifest,
  ensureProjectRegistry,
  ensureRegistryImage,
  gcOrphanProjectRegistries,
  projectRegistryClusterIp,
  projectRegistryConfDropIn,
  projectRegistryHost,
  projectRegistryHostname,
  projectRegistryName,
  projectRegistryStorageHostPath,
  removeProjectRegistry,
} from '@/lib/k8s/project-registry'
import { clusterIpForService } from '@/lib/k8s/bootstrap'
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
  it('builds the one svc-DNS host string used from every perspective', () => {
    const name = projectRegistryName('demo')
    expect(projectRegistryHostname('demo')).toBe(`${name}.test-ns.svc`)
    expect(projectRegistryHost('demo')).toBe(`${name}.test-ns.svc:${PROJECT_REGISTRY_PORT}`)
  })

  it('pins the Service VIP via the keyed generalization', () => {
    expect(projectRegistryClusterIp('demo'))
      .toBe(clusterIpForService('test-ns', projectRegistryName('demo')))
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
        clusterIP: projectRegistryClusterIp('demo'),
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
    // get service → absent; get nodes → one kind node.
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve(null)
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      return Promise.resolve(null)
    })
  })

  it('applies Deployment, Service, and both NetworkPolicies, then waits and wires the node', async () => {
    await ensureProjectRegistry('demo')

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['Deployment', 'Service', 'NetworkPolicy', 'NetworkPolicy'])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${projectRegistryName('demo')}`,
        '-n', 'test-ns', '--timeout=120s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    // hosts.toml written on the kind node via podman exec, mapping the
    // svc-DNS host dir to the pinned-VIP URL.
    const hostsCall = mockExec.mock.calls.find(
      (c) => c[0] === 'podman' && (c[1] as string[])[0] === 'exec',
    )
    expect(hostsCall).toBeDefined()
    const script = (hostsCall![1] as string[])[4]
    expect((hostsCall![1] as string[])[1]).toBe('yaac-control-plane')
    expect(script).toContain(`/etc/containerd/certs.d/${projectRegistryHost('demo')}`)
    expect(script).toContain(`http://${projectRegistryClusterIp('demo')}:${PROJECT_REGISTRY_PORT}`)
    // No drift → no Service delete.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })

  it('migrates a drifted Service: deletes it before re-applying (clusterIP immutable)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.1.2' } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      return Promise.resolve(null)
    })
    await ensureProjectRegistry('demo')
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'service', projectRegistryName('demo'), '-n', 'test-ns', '--ignore-not-found',
    ])
  })

  it('leaves a Service already at the pinned VIP untouched', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: projectRegistryClusterIp('demo') } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      return Promise.resolve(null)
    })
    await ensureProjectRegistry('demo')
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })
})

describe('removeProjectRegistry', () => {
  it('deletes by label selector scoped to this install and cleans the node', async () => {
    mockGetJson.mockResolvedValue(NODE_LIST)
    await removeProjectRegistry('demo')
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    const rmCall = mockExec.mock.calls.find(
      (c) => c[0] === 'podman' && (c[1] as string[])[4]?.includes('rm -rf'),
    )
    expect(rmCall).toBeDefined()
    const script = (rmCall![1] as string[])[4]
    expect(script).toContain(`/etc/containerd/certs.d/${projectRegistryHost('demo')}`)
    expect(script).toContain(projectRegistryStorageHostPath('demo'))
  })

  it('swallows node-side cleanup failures (cluster recreate)', async () => {
    mockGetJson.mockResolvedValue(NODE_LIST)
    mockExec.mockRejectedValue(new Error('no such container'))
    await expect(removeProjectRegistry('demo')).resolves.toBeUndefined()
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
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      return Promise.resolve(null)
    })

    await gcOrphanProjectRegistries()

    const deletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][3]).toContain('yaac.project=gone')
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(gcOrphanProjectRegistries()).resolves.toBeUndefined()
  })
})
