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
import { fakeRegistry } from '#test/support/fake-registry'
import { NETD_DIR } from '@yaac/shared/project-paths'

// `kubectl rollout status` is the one child process; it records its argv.
const mockExecFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, res: object) => void) => {
    mockExecFile(file, args)
    cb(null, { stdout: '', stderr: '' })
  },
}))

import { cniVethPrefix, contextHash, ensureNetd, registryRef, resolveNetdImageTag } from '#drivers/k8s/cluster'
// Setup values, not units under test.
import { DEFAULT_VETH_PREFIX, ENVOY_MIRROR_TAG } from '#drivers/k8s/cluster/netd'
import { resetClusterCidrCache } from '#drivers/k8s/cluster'

const applied = (kind: string): Record<string, unknown> | undefined => fakeCluster.get(kind, 'yaac-netd')

/** The netd image's tag, from the real build context. */
let netdTag: string

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  resetClusterCidrCache()
  netdTag = `yaac-netd:${await contextHash(NETD_DIR)}`
  fakeRegistry.install()
  fakeRegistry.tags.add(netdTag).add(ENVOY_MIRROR_TAG)
  fakeCluster.seed({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' }, spec: { podCIDR: '10.244.0.0/24' } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetClusterCidrCache()
})

describe('resolveNetdImageTag', () => {
  it('tags by the content of the k8s/netd build context, building nothing', async () => {
    // Both the install that builds the image and the lookup that uses it
    // derive this tag, so it must not need a registry or engine.
    fakeRegistry.down = true
    await expect(resolveNetdImageTag('yaac-netd')).resolves.toBe(netdTag)
    expect(mockExecFile).not.toHaveBeenCalled()
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

  it('resolves both images from the registry and never builds one', async () => {
    await ensureNetd()

    const ds = applied('DaemonSet') as {
      spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } }
    }
    const images = Object.fromEntries(
      ds.spec.template.spec.containers.map((c) => [c.name, c.image]),
    )
    expect(images.netd).toBe(registryRef(netdTag))
    expect(images.envoy).toBe(registryRef(ENVOY_MIRROR_TAG))
  })

  it('refuses with the command that produces it when an image is missing', async () => {
    // `yaac cluster install` pushes both images; the server has no engine
    // to build them.
    fakeRegistry.tags.delete(netdTag)
    await expect(ensureNetd()).rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    fakeRegistry.tags.add(netdTag).delete(ENVOY_MIRROR_TAG)
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
