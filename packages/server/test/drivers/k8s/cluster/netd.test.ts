/**
 * netd's own barrel surface: standing the redirect DaemonSet up, the two
 * image lookups it does first, and the veth prefix its rules key on.
 *
 * The DaemonSet's manifest *shape* is asserted through `ensureProxyResources`
 * in proxy-apply.test.ts, which is where production applies it; what these
 * cases pin is what netd resolves before applying — the images it will not
 * build, and the prefix a wrong value silently costs every worktree its
 * egress.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as imageEngineModule from '#drivers/k8s/image-engine'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
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
// Setup values: the default the prefix falls back to, and the pinned Envoy
// mirror tag netd's second lookup asks for.
import { DEFAULT_VETH_PREFIX, ENVOY_MIRROR_TAG } from '#drivers/k8s/cluster/netd'
import { resetClusterCidrCache } from '#drivers/k8s/cluster'

const applied = (kind: string): Record<string, unknown> | undefined =>
  mockKubectlApply.mock.calls
    .map((c) => c[0] as { kind: string })
    .find((m) => m.kind === kind) as Record<string, unknown> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  resetClusterCidrCache()
  mockContextHash.mockResolvedValue('abc123def4567890')
  mockRegistryHasTag.mockResolvedValue(true)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlGetJson.mockResolvedValue({ items: [{ spec: { podCIDR: '10.244.0.0/24' } }] })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetClusterCidrCache()
})

describe('resolveNetdImageTag', () => {
  it('tags by the content of the k8s/netd build context, building nothing', async () => {
    await expect(resolveNetdImageTag('yaac-netd')).resolves.toBe('yaac-netd:abc123def4567890')
    // A pure derivation — it is what both the install that produces the
    // image and the lookup that consumes it name, so it must not depend on
    // either a registry or an engine answering.
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
  it('applies the RBAC set and the DaemonSet, then waits for the rollout', async () => {
    await ensureNetd()

    // SA and its RBAC before the DaemonSet that names them: netd watches
    // pods cluster-wide to resolve each one's veth.
    expect(mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'DaemonSet',
    ])
    expect(mockKubectlWithRetry).toHaveBeenCalledWith(
      ['rollout', 'status', 'daemonset/yaac-netd', '-n', 'test-ns', '--timeout=180s'],
      expect.objectContaining({ maxAttempts: 2 }),
    )
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
    // Both halves are lookups: `yaac cluster install` puts them in the
    // registry, and a server standing netd up has no engine to build with.
    mockRegistryHasTag.mockImplementation((tag: string) =>
      Promise.resolve(!tag.startsWith('yaac-netd:')))
    await expect(ensureNetd()).rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    mockRegistryHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    await expect(ensureNetd()).rejects.toThrow(/Envoy image .* is missing.*yaac cluster install/s)
  })

  it('carries the veth prefix into the DaemonSet, so an override reaches the rules', async () => {
    // The prefix is what netd matches pod veths on. A value that resolves
    // nothing renders a redirect chain with no per-pod rules in it —
    // indistinguishable from a healthy netd until a worktree tries to
    // reach the internet.
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    await ensureNetd()

    const ds = applied('DaemonSet') as {
      spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value: string }> }> } } }
    }
    const env = ds.spec.template.spec.containers.flatMap((c) => c.env ?? [])
    expect(env.find((e) => e.name === 'NETD_VETH_PREFIX')?.value).toBe('eni')
  })
})
