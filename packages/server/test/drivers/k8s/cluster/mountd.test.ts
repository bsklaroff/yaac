/**
 * mountd's barrel functions: applying the DaemonSet and what guards
 * it, and the server's half of the conversation: reading each node's
 * report, deciding which nodes take new starts, and the bind and ready
 * requests. The cluster, the registry, `kubectl rollout status` and the
 * mountd's HTTP API are the boundaries.
 *
 * The bearer token is made once per process, so the first test here is the
 * one that sees its Secret created.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import type * as childProcess from 'node:child_process'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { globalRoot } from '@yaac/shared/paths'
import { MOUNTD_DIR } from '@yaac/shared/project-paths'
import { fakeRegistry } from '#test/support/fake-registry'
import { fakeMountd } from '#test/drivers/k8s/fake-mountd'

// The build every report is checked against, read once per process.
vi.hoisted(() => { process.env.YAAC_BUILD_ID = 'build-1' })

// `kubectl rollout status` is the one child process; it records its argv.
const mockExecFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, res: object) => void) => {
    mockExecFile(file, args)
    cb(null, { stdout: '', stderr: '' })
  },
}))

import {
  contextHash,
  ensureMountd,
  mountdBind,
  mountdKeepReady,
  mountdReports,
  nodeUnreadyReason,
  readyNodes,
  registryRef,
  resolveMountdImageTag,
  serverBuild,
  watchMountd,
} from '#drivers/k8s/cluster'
import {
  MOUNTD_PORT,
  installId,
  installSecurityContext,
  k8sNamespace,
  nodeLocalNodePath,
  nodeMountsNodePath,
} from '#drivers/k8s/substrate'

const GiB = 1024 ** 3
let dataDir: string

beforeEach(async () => {
  dataDir = await createTempDataDir()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await cleanupTempDir(dataDir)
})

interface Container {
  name: string
  image: string
  command: string[]
  securityContext: Record<string, unknown>
  resources: { limits: Record<string, string> }
  volumeMounts: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean; mountPropagation?: string }>
}
interface DaemonSet {
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    updateStrategy: unknown
    template: {
      spec: {
        serviceAccountName: string
        hostPID: boolean
        tolerations: unknown[]
        initContainers: Container[]
        containers: Container[]
        volumes: Array<{ name: string; hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string }; secret?: { secretName: string } }>
      }
    }
  }
}

describe('ensureMountd', () => {
  let tag: string

  beforeEach(async () => {
    mockExecFile.mockClear()
    tag = `yaac-mountd:${await contextHash(MOUNTD_DIR)}`
    fakeRegistry.install()
    fakeRegistry.tags.add(tag)
    fakeCluster.seed({
      apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice',
      metadata: { name: 'kubernetes', namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
      addressType: 'IPv4',
      endpoints: [{ addresses: ['172.18.0.2'] }],
      ports: [{ port: 6443 }],
    })
  })

  it('makes its token once, applies RBAC, both policies and the DaemonSet, and waits for every node', async () => {
    await ensureMountd()

    // The bearer token every request carries, in a Secret of its own.
    const [create] = fakeCluster.callsOf('create', 'Secret')
    expect(create.name).toBe('yaac-mountd-token')
    const token = Buffer.from((create.body as { data: { token: string } }).data.token, 'base64').toString('utf8')
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    expect(fakeCluster.callsOf('apply').map((c) => `${c.kind}/${c.name ?? ''}`)).toEqual([
      'ServiceAccount/yaac-mountd',
      'Role/yaac-mountd',
      'RoleBinding/yaac-mountd',
      'NetworkPolicy/yaac-mountd-ingress',
      'NetworkPolicy/yaac-mountd-egress',
      'DaemonSet/yaac-mountd',
    ])
    // It reads its node's pods and writes nothing.
    expect(fakeCluster.get<{ rules: unknown }>('Role', 'yaac-mountd')?.rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    ])
    // Only the server may dial it, and it may dial only the apiserver.
    expect(fakeCluster.get<{ spec: unknown }>('NetworkPolicy', 'yaac-mountd-ingress')?.spec).toEqual({
      podSelector: { matchLabels: { app: 'yaac-mountd' } },
      policyTypes: ['Ingress'],
      ingress: [{ from: [{ podSelector: { matchLabels: { 'yaac.role': 'server' } } }], ports: [{ protocol: 'TCP', port: MOUNTD_PORT }] }],
    })
    expect(fakeCluster.get<{ spec: unknown }>('NetworkPolicy', 'yaac-mountd-egress')?.spec).toEqual({
      podSelector: { matchLabels: { app: 'yaac-mountd' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '172.18.0.2/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] }],
    })
    expect(mockExecFile).toHaveBeenCalledWith(
      'kubectl', ['rollout', 'status', 'daemonset/yaac-mountd', '-n', k8sNamespace(), '--timeout=180s'],
    )
  })

  it('runs a privileged mountd in the host pid namespace and an unprivileged, bounded arborist', async () => {
    await ensureMountd()
    const ds = fakeCluster.get<DaemonSet>('DaemonSet', 'yaac-mountd')
    expect(ds?.metadata.labels).toEqual({ app: 'yaac-mountd', 'yaac.install-id': installId() })
    const pod = ds!.spec.template.spec
    // One node at a time, on every node.
    expect(ds!.spec.updateStrategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } })
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.hostPID).toBe(true)
    expect(pod.serviceAccountName).toBe('yaac-mountd')
    const { runAsUser: uid, runAsGroup: gid } = installSecurityContext()
    // The arborist's folder is the install uid's before the arborist starts.
    expect(pod.initContainers.map((c) => c.command)).toEqual([
      ['sh', '-c', `mkdir -p /node-local/ready && chown ${String(uid)}:${String(gid)} /node-local/ready`],
    ])

    const [mountd, arborist] = pod.containers
    expect(mountd.name).toBe('mountd')
    expect(mountd.command[0]).toBe('mountd')
    expect(arborist.command[0]).toBe('arborist')
    expect(mountd.image).toBe(registryRef(tag))
    expect(mountd.securityContext).toEqual({ privileged: true, runAsUser: 0, runAsGroup: 0 })
    const flag = (name: string): string => mountd.command[mountd.command.indexOf(name) + 1]
    // It reports the build it was applied with, which a start checks.
    expect(flag('--build')).toBe('build-1')
    expect(flag('--node-mounts-on-node')).toBe(nodeMountsNodePath())
    expect(flag('--tiers')).toBe('shared=/shared,volumes=/volumes')
    expect(flag('--listen')).toBe(`:${String(MOUNTD_PORT)}`)
    // Its mounts reach the node, and from there each pod's node-mounts dir.
    expect(mountd.volumeMounts.filter((m) => m.mountPropagation !== undefined)).toEqual([
      { name: 'node-mounts', mountPath: '/node-mounts-root', mountPropagation: 'Bidirectional' },
      { name: 'node-local', mountPath: '/node-local', mountPropagation: 'Bidirectional' },
    ])
    expect(mountd.volumeMounts).toContainEqual({ name: 'token', mountPath: '/etc/yaac-mountd', readOnly: true })

    expect(arborist.name).toBe('arborist')
    expect(arborist.securityContext).toEqual({
      runAsUser: uid, runAsGroup: gid, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
    })
    // Its limits are all that bound a burst of builds.
    expect(arborist.resources.limits).toEqual({ cpu: '4', memory: '1Gi' })
    // The main clones read-only at the server's own path, since a fork's
    // borrows from its upstream's by that path; `ready/` its only write.
    const repos = path.posix.join(globalRoot(), 'repos')
    expect(arborist.volumeMounts).toEqual([
      { name: 'shared', mountPath: repos, subPath: 'repos', readOnly: true },
      { name: 'ready', mountPath: '/ready' },
    ])
    expect(arborist.command).toEqual(expect.arrayContaining(['--repos', repos]))

    const volume = (name: string) => pod.volumes.find((v) => v.name === name)
    expect(volume('node-mounts')?.hostPath?.path).toBe(nodeMountsNodePath())
    expect(volume('node-local')?.hostPath?.path).toBe(nodeLocalNodePath())
    expect(volume('ready')?.hostPath?.path).toBe(`${nodeLocalNodePath()}/ready`)
    expect(volume('host-bin')?.hostPath?.path).toBe('/usr/local/bin')
    expect(volume('volumes')?.persistentVolumeClaim?.claimName).toBe('yaac-volumes')
    expect(volume('token')?.secret?.secretName).toBe('yaac-mountd-token')
  })

  it('leaves the volumes claim out where each byo volume is a claim of its own', async () => {
    vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', 'hcloud-volumes')
    await ensureMountd()
    const pod = fakeCluster.get<DaemonSet>('DaemonSet', 'yaac-mountd')!.spec.template.spec
    const mountd = pod.containers[0]
    expect(mountd.command[mountd.command.indexOf('--tiers') + 1]).toBe('shared=/shared')
    expect(pod.volumes.map((v) => v.name)).not.toContain('volumes')
  })

  it('refuses with the command that produces its image when the registry lacks it', async () => {
    fakeRegistry.tags.delete(tag)
    await expect(ensureMountd()).rejects.toThrow(/mountd image .* is missing.*yaac cluster install/s)
    expect(fakeCluster.callsOf('apply', 'DaemonSet')).toEqual([])
  })
})

describe('resolveMountdImageTag', () => {
  it('tags by the content of the k8s/mountd build context, asking no registry', async () => {
    fakeRegistry.install()
    fakeRegistry.down = true
    const hash = await contextHash(MOUNTD_DIR)
    await expect(resolveMountdImageTag()).resolves.toBe(`yaac-mountd:${hash}`)
    await expect(resolveMountdImageTag('yaac-test-mountd')).resolves.toBe(`yaac-test-mountd:${hash}`)
  })
})

describe('serverBuild', () => {
  it('answers this process\'s build, read once', async () => {
    await expect(serverBuild()).resolves.toBe('build-1')
    vi.stubEnv('YAAC_BUILD_ID', 'build-2')
    await expect(serverBuild()).resolves.toBe('build-1')
  })
})

/**
 * Five mountd pods, one ready and four for each way a node takes no start:
 * another build, its arborist down, under the disk stop floor, and
 * refusing to report.
 */
async function mixedAgents(): Promise<void> {
  await fakeMountd.install(['n1', 'n2', 'n3', 'n4', 'n5'])
  fakeMountd.reports.set('n2', await fakeMountd.goodReport({ build: 'build-0' }))
  fakeMountd.reports.set('n3', await fakeMountd.goodReport({ arborist: false }))
  fakeMountd.reports.set('n4', await fakeMountd.goodReport({ freeBytes: 4 * GiB }))
  fakeMountd.reports.set('n5', new Error('statfs failed'))
  await fakeMountd.settle(['n1'])
}

describe('readyNodes', () => {
  it('counts only a node whose mountd answered on the server\'s build, with its arborist up, above the stop floor', async () => {
    await mixedAgents()
    expect(readyNodes()).toEqual(['n1'])
    // A good report goes stale: a node takes no start on an old one.
    expect(readyNodes(Date.now() + 16_000)).toEqual([])
  })
})

describe('nodeUnreadyReason', () => {
  it('names why each node takes no start, and null for one that does', async () => {
    await mixedAgents()
    expect(nodeUnreadyReason('n1')).toBeNull()
    expect(nodeUnreadyReason('n2')).toBe('its mountd runs build build-0, not the server\'s')
    expect(nodeUnreadyReason('n3')).toBe('its arborist does not answer')
    expect(nodeUnreadyReason('n4')).toBe('it is under the disk stop floor')
    expect(nodeUnreadyReason('n5')).toBe('mountd refused /report: statfs failed')
    expect(nodeUnreadyReason('n9')).toBe('no mountd runs there')
    expect(nodeUnreadyReason('n1', Date.now() + 16_000)).toBe('its mountd has not answered recently')
    // The floor is the operator's.
    vi.stubEnv('YAAC_DISK_STOP_FLOOR_GIB', '2')
    expect(nodeUnreadyReason('n4')).toBeNull()
  })
})

describe('mountdReports', () => {
  it('answers each node\'s last report on the server\'s build that it gave', async () => {
    await mixedAgents()
    const reports = mountdReports()
    expect([...reports.keys()].sort()).toEqual(['n1', 'n3', 'n4'])
    expect(reports.get('n4')).toEqual(await fakeMountd.goodReport({ freeBytes: 4 * GiB }))
  })
})

describe('watchMountd', () => {
  it('asks every mountd at once with the install\'s token, again every five seconds, and drops a node whose mountd is gone', async () => {
    vi.useFakeTimers()
    await fakeMountd.install(['n1', 'n2'])
    const stop = watchMountd()
    await vi.waitFor(() => { expect(readyNodes().sort()).toEqual(['n1', 'n2']) })
    const reads = fakeMountd.sent('/report')
    expect(reads.map((r) => `${r.method} ${r.node}`).sort()).toEqual(['GET n1', 'GET n2'])
    expect(reads[0].authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
    expect(reads[1].authorization).toBe(reads[0].authorization)

    // A change on a node is seen at the next ask.
    fakeMountd.reports.set('n2', await fakeMountd.goodReport({ arborist: false }))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => { expect(readyNodes()).toEqual(['n1']) })

    // A mountd pod that is gone takes its node with it.
    fakeCluster.remove('Pod', 'yaac-mountd-n1', k8sNamespace())
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => { expect(nodeUnreadyReason('n1')).toBe('no mountd runs there') })

    stop()
    const asked = fakeMountd.sent('/report').length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fakeMountd.sent('/report')).toHaveLength(asked)
  })
})

describe('mountdBind', () => {
  beforeEach(async () => {
    await fakeMountd.install(['n1'])
  })

  it('posts the bind to its node\'s mountd, and fails with mountd\'s own reason', async () => {
    await mountdBind('n1', { pod: 'yaac-w1-x', dir: 'w1.0a0b0c0d' })
    expect(fakeMountd.sent('/bind')).toEqual([expect.objectContaining({
      node: 'n1', method: 'POST', body: { pod: 'yaac-w1-x', dir: 'w1.0a0b0c0d' },
    })])

    fakeMountd.refusals.set('POST /bind', 'runsc exec failed')
    await expect(mountdBind('n1', {})).rejects.toThrow('mountd refused /bind: runsc exec failed')
  })

  it('waits for a mountd it cannot reach, as while its pod is replaced, and gives up after a while', async () => {
    vi.useFakeTimers()
    const mountdPod = fakeCluster.get<Parameters<typeof fakeCluster.seed>[0]>('Pod', 'yaac-mountd-n1')!
    fakeCluster.remove('Pod', 'yaac-mountd-n1', k8sNamespace())
    const bound = mountdBind('n1', { pod: 'yaac-w1-x' })
    await vi.advanceTimersByTimeAsync(3_000)
    fakeCluster.seed(mountdPod)
    fakeMountd.down.add('n1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fakeMountd.sent('/bind')).toHaveLength(3)
    fakeMountd.down.delete('n1')
    await vi.advanceTimersByTimeAsync(1_000)
    await bound
    expect(fakeMountd.sent('/bind')).toHaveLength(4)

    const gone = expect(mountdBind('n9', {})).rejects.toThrow('no mountd runs on node n9')
    await vi.advanceTimersByTimeAsync(91_000)
    await gone
  })
})

describe('mountdKeepReady', () => {
  it('puts the node\'s set of trees to keep ready', async () => {
    await fakeMountd.install(['n1'])
    await mountdKeepReady('n1', [{ repo: 'r1', commit: 'abc' }])
    expect(fakeMountd.sent('/ready')).toEqual([expect.objectContaining({
      node: 'n1', method: 'PUT', body: { want: [{ repo: 'r1', commit: 'abc' }] },
    })])
  })
})
