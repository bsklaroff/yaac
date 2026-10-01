/**
 * The npm cache's barrel functions: deploying Verdaccio, and the URL a
 * workspace create reads to decide whether pnpm installs through it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as registryModule from '#drivers/k8s/container/registry'

// kubectl is the process boundary; everything behind it runs for real.
const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
}))

// The node-CIDR probe behind the network policies reads the live cluster.
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  clusterPodCidrs: vi.fn().mockResolvedValue(['10.244.0.0/16']),
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
}))

import { VERDACCIO_MIRROR_TAG, ensureNpmCache, servingNpmCacheUrl } from '#drivers/k8s/cluster'

interface Manifest {
  kind: string
  metadata: { name: string; namespace: string }
  spec: Record<string, unknown>
  data?: Record<string, string>
}

const applied = (): Manifest[] => mockKubectlApply.mock.calls.map((c) => c[0] as Manifest)
const appliedNamed = (kind: string, name: string): Manifest | undefined =>
  applied().find((m) => m.kind === kind && m.metadata.name === name)

beforeEach(() => {
  vi.clearAllMocks()
  mockRegistryHasTag.mockResolvedValue(true)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
})

describe('ensureNpmCache', () => {
  it('stands up one read-only Verdaccio on its claim, walled to workspaces, and publishes it last', async () => {
    await ensureNpmCache()

    const config = appliedNamed('ConfigMap', 'yaac-npm-cache-config')?.data?.['config.yaml'] ?? ''
    // Nothing may publish into a cache every project's workspaces share.
    expect(config).not.toMatch(/publish: \$(all|authenticated)/)
    expect(config.match(/publish: \$nobody/g)).toHaveLength(4)
    expect(config).toContain('url: https://registry.npmjs.org/')

    // One writer at a time: one replica, recreated rather than rolled.
    const deploy = appliedNamed('Deployment', 'yaac-npm-cache')
    expect(deploy?.metadata.namespace).toBe('test-ns')
    expect(deploy?.spec).toMatchObject({
      replicas: 1,
      strategy: { type: 'Recreate' },
      template: {
        spec: {
          // The uplink resolves as-is, never via the node's search domains.
          dnsConfig: { options: [{ name: 'ndots', value: '1' }] },
          containers: [{ image: `localhost:5001/${VERDACCIO_MIRROR_TAG}` }],
          volumes: expect.arrayContaining([
            { name: 'storage', persistentVolumeClaim: { claimName: 'yaac-npm-cache-storage-ddh16' } },
          ]) as unknown,
        },
      },
    })
    // No storageClassName: binds through the cluster's default class.
    expect(appliedNamed('PersistentVolumeClaim', 'yaac-npm-cache-storage-ddh16')?.spec).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '20Gi' } },
    })

    // Only workspace pods labelled for the cache (a project with
    // `npmCache: false` gets no label), on both ends of the connection.
    const admitted = {
      matchLabels: { 'yaac.npm-cache': 'true' },
      matchExpressions: [{ key: 'yaac.workspace-id', operator: 'Exists' }],
    }
    expect(appliedNamed('NetworkPolicy', 'yaac-npm-cache-ingress')?.spec).toEqual({
      podSelector: { matchLabels: { app: 'yaac-npm-cache' } },
      policyTypes: ['Ingress'],
      ingress: [
        { from: [{ podSelector: admitted }], ports: [{ protocol: 'TCP', port: 4873 }] },
        { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 4873 }] },
      ],
    })
    expect(appliedNamed('NetworkPolicy', 'yaac-npm-cache-workspace-egress')?.spec).toEqual({
      podSelector: admitted,
      policyTypes: ['Egress'],
      egress: [{
        to: [{ podSelector: { matchLabels: { app: 'yaac-npm-cache' } } }],
        ports: [{ protocol: 'TCP', port: 4873 }],
      }],
    })
    // Egress to npmjs, but never to in-cluster 443 listeners.
    expect(appliedNamed('NetworkPolicy', 'yaac-npm-cache-egress')?.spec).toMatchObject({
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.244.0.0/16', '10.89.0.7/32'] } }],
          ports: [{ protocol: 'TCP', port: 443 }],
        },
        { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      ],
    })

    // The Service is applied last, after the rollout, so a cache that
    // never came up has no Service.
    const kinds = applied().map((m) => m.kind)
    expect(kinds.at(-1)).toBe('Service')
    const rollout = mockKubectlWithRetry.mock.calls.findIndex(([args]) =>
      (args as string[]).join(' ').startsWith('rollout status deployment/yaac-npm-cache'))
    expect(rollout).toBeGreaterThanOrEqual(0)
    expect(mockKubectlWithRetry.mock.invocationCallOrder[rollout])
      .toBeLessThan(mockKubectlApply.mock.invocationCallOrder.at(-1)!)
  })

  it('publishes no Service for a cache that never rolled out', async () => {
    mockKubectlWithRetry.mockRejectedValue(new Error('timed out waiting for the condition'))

    await expect(ensureNpmCache()).rejects.toThrow(/no default StorageClass/)
    expect(applied().some((m) => m.kind === 'Service')).toBe(false)
  })

  it('refuses before applying anything when the image was never mirrored', async () => {
    mockRegistryHasTag.mockResolvedValue(false)

    await expect(ensureNpmCache()).rejects.toThrow(/Verdaccio/)
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })
})

describe('servingNpmCacheUrl', () => {
  // pnpm has no fallback registry, so a workspace pointed at a down cache
  // fails every install. The URL is given only while a pod is ready, and
  // is checked on every call.
  it('names the Service only while a cache pod is ready behind it', async () => {
    const slices = (ready?: boolean): unknown => ({
      items: ready === undefined ? [] : [{ endpoints: [{ conditions: { ready } }] }],
    })
    const url = 'http://yaac-npm-cache.test-ns.svc.cluster.local:4873/'
    mockKubectlGetJson
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(slices())
      .mockResolvedValueOnce(slices(false))
      .mockResolvedValueOnce(slices(true))
      .mockResolvedValueOnce(slices(false))

    await expect(servingNpmCacheUrl()).resolves.toBeNull()
    await expect(servingNpmCacheUrl()).resolves.toBeNull()
    await expect(servingNpmCacheUrl()).resolves.toBeNull()
    await expect(servingNpmCacheUrl()).resolves.toBe(url)
    await expect(servingNpmCacheUrl()).resolves.toBeNull()
    expect(mockKubectlGetJson).toHaveBeenLastCalledWith([
      'get', 'endpointslices', '-n', 'test-ns', '-l', 'kubernetes.io/service-name=yaac-npm-cache',
    ])
  })
})
