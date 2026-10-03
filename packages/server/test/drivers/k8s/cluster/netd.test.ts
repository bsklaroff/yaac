/**
 * netd's barrel functions: applying the redirect DaemonSet, the two image
 * lookups it does first, and the veth prefix its rules match on.
 *
 * The DaemonSet's manifest shape is asserted in proxy-apply.test.ts, through
 * `ensureProxyResources`, which is what applies it in production.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type * as childProcess from 'node:child_process'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as imageEngineModule from '#drivers/k8s/image-engine'

// `kubectl rollout status` is the one child process; it records its argv.
const mockExecFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, res: object) => void) => {
    mockExecFile(file, args)
    cb(null, { stdout: '', stderr: '' })
  },
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
}))

const mockContextHash = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/image-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof imageEngineModule>()),
  contextHash: mockContextHash,
}))

import { cniVethPrefix, ensureNetd, resolveNetdImageTag } from '#drivers/k8s/cluster'
// Setup values, not units under test.
import { DEFAULT_VETH_PREFIX, ENVOY_MIRROR_TAG } from '#drivers/k8s/cluster/netd'
import { resetClusterCidrCache } from '#drivers/k8s/cluster'

const applied = (kind: string): Record<string, unknown> | undefined => fakeCluster.get(kind, 'yaac-netd')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  resetClusterCidrCache()
  mockContextHash.mockResolvedValue('abc123def4567890')
  mockRegistryHasTag.mockResolvedValue(true)
  fakeCluster.seed({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' }, spec: { podCIDR: '10.244.0.0/24' } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetClusterCidrCache()
})

describe('resolveNetdImageTag', () => {
  it('tags by the content of the k8s/netd build context, building nothing', async () => {
    await expect(resolveNetdImageTag('yaac-netd')).resolves.toBe('yaac-netd:abc123def4567890')
    // Both the install that builds the image and the lookup that uses it
    // derive this tag, so it must not need a registry or engine.
    expect(mockRegistryHasTag).not.toHaveBeenCalled()

    mockContextHash.mockResolvedValue('0000111122223333')
    await expect(resolveNetdImageTag('yaac-netd')).resolves.toBe('yaac-netd:0000111122223333')
  })
})

describe('cniVethPrefix', () => {
  it('defaults to Calico\'s, and honors the operator\'s override', () => {
    expect(cniVethPrefix()).toBe(DEFAULT_VETH_PREFIX)
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    expect(cniVethPrefix()).toBe('eni')
  })
})

describe('ensureNetd', () => {
  it('applies namespaced RBAC and the DaemonSet, waits for the rollout, then drops the old cluster RBAC', async () => {
    await ensureNetd()

    // RBAC before the DaemonSet that uses it. netd reads only its own
    // namespace, so nothing it is granted is cluster-wide.
    expect(fakeCluster.callsOf('apply').map((c) => c.kind)).toEqual(['ServiceAccount', 'Role', 'RoleBinding', 'DaemonSet'])
    const role = applied('Role') as { metadata: { namespace: string }; rules: Array<{ resources: string[]; verbs: string[] }> }
    expect(role.metadata.namespace).toBe('test-ns')
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] },
    ])

    expect(mockExecFile).toHaveBeenCalledWith(
      'kubectl', ['rollout', 'status', 'daemonset/yaac-netd', '-n', 'test-ns', '--timeout=180s'],
    )
  })

  it('drops the cluster RBAC an older netd of this install left, after the rollout', async () => {
    const legacy = (kind: string, ns: string) => ({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind,
      metadata: { name: `yaac-netd-${ns}`, labels: { app: 'yaac-netd', 'yaac.install-namespace': ns } },
    })
    fakeCluster.seed(
      legacy('ClusterRole', 'test-ns'), legacy('ClusterRoleBinding', 'test-ns'), legacy('ClusterRole', 'other-ns'),
    )
    // The pods being replaced keep their watch until the rollout is done.
    fakeCluster.intercept((call) => {
      if (call.verb === 'delete') expect(mockExecFile).toHaveBeenCalled()
    })
    await ensureNetd()

    expect(fakeCluster.objects('ClusterRole').map((o) => o.metadata.name)).toEqual(['yaac-netd-other-ns'])
    expect(fakeCluster.objects('ClusterRoleBinding')).toEqual([])
  })

  it('resolves both images from the registry and never builds one', async () => {
    await ensureNetd()

    const ds = applied('DaemonSet') as {
      spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } }
    }
    const images = Object.fromEntries(
      ds.spec.template.spec.containers.map((c) => [c.name, c.image]),
    )
    expect(images.netd).toBe('localhost:5001/yaac-netd:abc123def4567890')
    expect(images.envoy).toBe(`localhost:5001/${ENVOY_MIRROR_TAG}`)
  })

  it('refuses with the command that produces it when an image is missing', async () => {
    // `yaac cluster install` pushes both images; the server has no engine
    // to build them.
    mockRegistryHasTag.mockImplementation((tag: string) =>
      Promise.resolve(!tag.startsWith('yaac-netd:')))
    await expect(ensureNetd()).rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    mockRegistryHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    await expect(ensureNetd()).rejects.toThrow(/Envoy image .* is missing.*yaac cluster install/s)
  })

  it('carries the veth prefix into the DaemonSet, so an override reaches the rules', async () => {
    // A prefix that matches no veth yields no per-pod redirect rules, which
    // looks healthy until a workspace tries to reach the internet.
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    await ensureNetd()

    const ds = applied('DaemonSet') as {
      spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value: string }> }> } } }
    }
    const env = ds.spec.template.spec.containers.flatMap((c) => c.env ?? [])
    expect(env.find((e) => e.name === 'NETD_VETH_PREFIX')?.value).toBe('eni')
  })
})
