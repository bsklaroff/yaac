/**
 * netd's barrel functions: applying the DaemonSet (the Go relay and the
 * memory guard) and the image lookups it does first.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type * as childProcess from 'node:child_process'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { fakeRegistry } from '#test/support/fake-registry'
import { MOUNTD_DIR, NETD_DIR } from '@yaac/shared/project-paths'

// `kubectl rollout status` is the one child process; it records its argv.
const mockExecFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, res: object) => void) => {
    mockExecFile(file, args)
    cb(null, { stdout: '', stderr: '' })
  },
}))

import { contextHash, ensureNetd, registryRef, resolveNetdImageTag } from '#drivers/k8s/cluster'
import { resetClusterCidrCache } from '#drivers/k8s/cluster'
import { socketsNodePath } from '#drivers/k8s/substrate'

const applied = (kind: string): Record<string, unknown> | undefined => fakeCluster.get(kind, 'yaac-netd')

/** The netd and mountd images' tags, from the real build contexts. */
let netdTag: string
let mountdTag: string

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  resetClusterCidrCache()
  netdTag = `yaac-netd:${await contextHash(NETD_DIR)}`
  mountdTag = `yaac-mountd:${await contextHash(MOUNTD_DIR)}`
  fakeRegistry.install()
  fakeRegistry.tags.add(netdTag).add(mountdTag)
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

describe('ensureNetd', () => {
  it('applies namespaced RBAC and the DaemonSet, and waits for the rollout', async () => {
    await ensureNetd()

    // RBAC and its policies before the DaemonSet: netd reads only its own
    // namespace, so nothing it is granted is cluster-wide, and the
    // namespace's world-deny would otherwise start it cut off.
    expect(fakeCluster.callsOf('apply').map((c) => `${c.kind}/${c.name ?? ''}`)).toEqual([
      'ServiceAccount/yaac-netd', 'Role/yaac-netd', 'RoleBinding/yaac-netd',
      'NetworkPolicy/yaac-netd-ingress', 'NetworkPolicy/yaac-netd-egress', 'DaemonSet/yaac-netd',
    ])
    const role = applied('Role') as { metadata: { namespace: string }; rules: Array<{ resources: string[]; verbs: string[] }> }
    expect(role.metadata.namespace).toBe('test-ns')
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] },
    ])

    expect(mockExecFile).toHaveBeenCalledWith(
      'kubectl', ['rollout', 'status', 'daemonset/yaac-netd', '-n', 'test-ns', '--timeout=180s'],
    )
  })

  it('runs the relay off the host network with no capability, on this install\'s socket root and the proxy\'s secret', async () => {
    await ensureNetd()

    type Container = {
      name: string
      image: string
      command?: string[]
      securityContext: { runAsUser: number; capabilities: { drop?: string[]; add?: string[] } }
      readinessProbe?: { exec: { command: string[] } }
      volumeMounts: Array<{ name: string; mountPath: string }>
    }
    const ds = applied('DaemonSet') as {
      spec: { template: { spec: {
        hostNetwork?: boolean
        containers: Container[]
        volumes: Array<{ name: string; hostPath?: { path: string }; secret?: { secretName: string } }>
      } } }
    }
    const spec = ds.spec.template.spec
    expect(spec.hostNetwork).toBeUndefined()
    const byName = Object.fromEntries(spec.containers.map((c) => [c.name, c]))
    // The images: netd's own, and the relay in mountd's, both looked up.
    expect(byName.netd.image).toBe(registryRef(netdTag))
    expect(byName.relay.image).toBe(registryRef(mountdTag))
    for (const c of spec.containers) {
      expect(c.securityContext).toEqual({ runAsUser: 0, capabilities: { drop: ['ALL'] } })
    }

    // The node root, mounted at a short path for the 107-byte socket cap.
    const relay = byName.relay
    const arg = (flag: string): string | undefined => relay.command?.[relay.command.indexOf(flag) + 1]
    expect(arg('-root')).toBe('/s')
    expect(arg('-node-root')).toBe(socketsNodePath())
    expect(arg('-proxy')).toBe('yaac-proxy.test-ns.svc.cluster.local:10261')
    expect(arg('-stream-listen')).toBe(':10262')
    expect(arg('-site-listen')).toBe(':10263')
    expect(arg('-stream-port')).toBe('10300')
    expect(relay.volumeMounts.find((m) => m.mountPath === '/s')?.name).toBe('sockets')
    expect(spec.volumes.find((v) => v.name === 'sockets')?.hostPath?.path).toBe(socketsNodePath())
    expect(spec.volumes.find((v) => v.name === 'secret')?.secret?.secretName).toBe('yaac-proxy-auth')
    // Ready once its listeners are bound.
    expect(relay.readinessProbe?.exec.command).toEqual(['test', '-f', arg('-ready-file')])
    // netd keeps the cgroup tree for the swap bound and the pressure kill.
    expect(spec.volumes.find((v) => v.name === 'cgroup')?.hostPath?.path).toBe('/sys/fs/cgroup')
  })

  it('refuses with the command that produces it when an image is missing', async () => {
    // `yaac cluster install` pushes both images; the server has no engine
    // to build them.
    fakeRegistry.tags.delete(netdTag)
    await expect(ensureNetd()).rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    fakeRegistry.tags.add(netdTag).delete(mountdTag)
    await expect(ensureNetd()).rejects.toThrow(/mountd image .* is missing.*yaac cluster install/s)
  })
})
