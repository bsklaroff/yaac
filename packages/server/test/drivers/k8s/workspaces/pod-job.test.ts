import { describe, it, expect } from 'vitest'
import { CONTAINER_TMUX_DIR } from '@yaac/shared/paths'
import {
  CA_CONFIGMAP_NAME,
  installSecurityContext,
  nodeMountsNodePath,
  sentryTmpfsAnnotations,
} from '#drivers/k8s/substrate'
import { buildPodJobManifest } from '#drivers/k8s/workspaces'
// Internals, for fixtures and bounds only.
import {
  CA_MOUNT_DIR,
  PRE_STOP_GRACE_SECONDS,
  SCRATCH_REQUEST_BYTES,
  SCRATCH_SIZELIMIT_SLACK_BYTES,
  TREE_FINAL_PASS_SECONDS,
  TREE_RESOURCES,
  TREE_TRIGGER_DIR,
  TREE_TRIGGER_FILE,
  type PodJobParams,
} from '#drivers/k8s/workspaces/pod-job'

const GiB = 1024 ** 3

function params(overrides: Partial<PodJobParams> = {}): PodJobParams {
  return {
    jobName: 'yaac-abcd',
    namespace: 'test-ns',
    labels: {
      'yaac.workspace-id': 'abcd',
      'yaac.install-id': 'test-install',
    },
    image: 'localhost:5000/yaac-tools:abc',
    env: ['YAAC_WORKSPACE_ID=abcd', 'X=a=b'],
    nodeMountsDir: 'abcd.0f0f0f0f',
    helpers: 'run/helpers/build-1',
    scratchBytes: 32 * GiB,
    memoryRequestBytes: 1 * GiB,
    memoryLimitBytes: 8 * GiB,
    cpuRequestMillis: 250,
    cpuLimitMillis: 8000,
    ephemeralStorageRequestBytes: 2 * GiB,
    ephemeralStorageLimitBytes: 16 * GiB,
    // The proxy Service's ClusterIP, never a DNS name.
    proxyHost: '10.96.0.179',
    treeImage: 'registry.local/yaac-base:abc',
    nodeNames: ['n1', 'n2'],
    ...overrides,
  }
}

interface Mount { name: string; mountPath: string; subPath?: string; readOnly?: boolean; mountPropagation?: string }
interface Container {
  name: string
  image: string
  imagePullPolicy: string
  restartPolicy?: string
  workingDir?: string
  command?: string[]
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>
  securityContext?: { runAsUser?: number; runAsGroup?: number; capabilities?: { add?: string[]; drop?: string[] } }
  startupProbe?: unknown
  lifecycle?: { postStart?: { exec?: { command: string[] } }; preStop?: { exec?: { command: string[] } } }
  volumeMounts: Mount[]
  resources: { requests: Record<string, string>; limits: Record<string, string> }
}
interface Manifest {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    backoffLimit: number
    template: {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> }
      spec: {
        restartPolicy: string
        terminationGracePeriodSeconds: number
        priorityClassName: string
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        runtimeClassName: string
        dnsPolicy: string
        dnsConfig: { nameservers: string[] }
        hostAliases?: unknown
        securityContext: Record<string, unknown>
        affinity: unknown
        topologySpreadConstraints: unknown[]
        initContainers?: Container[]
        containers: Container[]
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
          emptyDir?: { sizeLimit?: string }
          persistentVolumeClaim?: { claimName: string }
        }>
      }
    }
  }
}

function build(overrides: Partial<PodJobParams> = {}): Manifest {
  return buildPodJobManifest(params(overrides)) as unknown as Manifest
}

describe('buildPodJobManifest', () => {
  it('builds a single-shot Job carrying its labels, whose pod holds nothing a project owns', () => {
    const m = build()
    expect(m).toMatchObject({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'yaac-abcd', namespace: 'test-ns', labels: params().labels },
      spec: { backoffLimit: 0, template: { metadata: { labels: params().labels }, spec: { restartPolicy: 'Never' } } },
    })
    const pod = m.spec.template.spec
    const [workspace] = pod.containers
    expect(pod.containers).toHaveLength(1)
    expect(workspace).toMatchObject({ name: 'workspace', image: params().image, imagePullPolicy: 'IfNotPresent', workingDir: '/' })
    // Only the variables it was given, split at the first `=`.
    expect(workspace.env).toEqual([{ name: 'YAAC_WORKSPACE_ID', value: 'abcd' }, { name: 'X', value: 'a=b' }])

    // Every volume is the same for any workspace: the pod's own node-mounts
    // directory, this build's helpers, CA trust and pod-local scratch. No
    // other hostPath, so nothing of a project's is reachable at creation.
    expect(pod.volumes).toEqual([
      { name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/abcd.0f0f0f0f`, type: 'DirectoryOrCreate' } },
      { name: 'helpers', persistentVolumeClaim: { claimName: 'yaac-global' } },
      { name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } },
      { name: 'tmux', emptyDir: {} },
      { name: 'local', emptyDir: {} },
      { name: 'tree-trigger', emptyDir: { sizeLimit: '1Mi' } },
      { name: 'scratch', emptyDir: { sizeLimit: String(32 * GiB + SCRATCH_SIZELIMIT_SLACK_BYTES) } },
    ])
    expect(workspace.volumeMounts).toEqual([
      // Read-only, and receiving what mountd mounts beneath it later.
      { name: 'node-mounts', mountPath: '/node-mounts', readOnly: true, mountPropagation: 'HostToContainer' },
      { name: 'helpers', mountPath: '/opt/yaac/helpers', readOnly: true, subPath: 'run/helpers/build-1' },
      { name: 'proxy-ca', mountPath: CA_MOUNT_DIR, readOnly: true },
      { name: 'tmux', mountPath: CONTAINER_TMUX_DIR },
      { name: 'local', mountPath: '/yaac-local' },
      { name: 'tree-trigger', mountPath: TREE_TRIGGER_DIR },
      { name: 'scratch', mountPath: '/yaac-scratch' },
    ])
    // The same generic setup and teardown hooks for every workspace, from
    // the helpers folder rather than the image.
    expect(workspace.lifecycle).toEqual({
      postStart: { exec: { command: ['/opt/yaac/helpers/bin/yaac-workspace-init'] } },
      preStop: { exec: { command: ['/opt/yaac/helpers/bin/yaac-opencode-checkpoint', 'stop'] } },
    })
  })

  it('makes the scratch volume a sentry tmpfs of its size, recorded for its pool, and sizes storage around it', () => {
    const m = build({ scratchBytes: 8 * GiB })
    expect(m.spec.template.metadata.annotations).toEqual({
      // A live sandbox must never be evicted to drain a node.
      'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
      ...sentryTmpfsAnnotations('scratch', 8 * GiB),
      'yaac.scratch-bytes': String(8 * GiB),
    })
    expect(m.spec.template.spec.containers[0].resources).toEqual({
      requests: {
        cpu: '250m',
        memory: String(1 * GiB),
        // One typical install on top of the writable layer.
        'ephemeral-storage': String(2 * GiB + SCRATCH_REQUEST_BYTES),
      },
      limits: {
        cpu: '8000m',
        memory: String(8 * GiB),
        // Above the volume's sizeLimit, so a full scratch dir fails writes
        // instead of evicting the pod.
        'ephemeral-storage': String(16 * GiB + 8 * GiB + SCRATCH_SIZELIMIT_SLACK_BYTES),
      },
    })
  })

  it('hardens the pod, resolves through the proxy, and runs it only on the nodes it is given', () => {
    const pod = build().spec.template.spec
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.enableServiceLinks).toBe(false)
    expect(pod.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' }, ...installSecurityContext() })
    expect(pod.runtimeClassName).toBe('gvisor')
    expect(pod.dnsPolicy).toBe('None')
    expect(pod.dnsConfig).toEqual({ nameservers: ['10.96.0.179'] })
    expect(pod.hostAliases).toBeUndefined()
    expect(pod.priorityClassName).toBe('yaac-workspace')
    expect(build({ priorityClassName: 'yaac-release' }).spec.template.spec.priorityClassName).toBe('yaac-release')
    // Only a node whose agent is ready can make the pod its workspace's.
    expect(pod.affinity).toEqual({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['n1'] }] },
            { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['n2'] }] },
          ],
        },
      },
    })
    // A preference to spread the install's workspaces, never a block.
    expect(pod.topologySpreadConstraints).toEqual([{
      maxSkew: 1,
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'ScheduleAnyway',
      labelSelector: { matchLabels: { 'yaac.install-id': 'test-install' } },
    }])
  })

  it('runs the tree container as a native sidecar that may bind its entries, and gives it the final pass\'s grace', () => {
    const pod = build().spec.template.spec
    expect(pod.initContainers).toHaveLength(1)
    const [tree] = pod.initContainers ?? []
    expect(tree).toMatchObject({
      name: 'tree',
      image: 'registry.local/yaac-base:abc',
      restartPolicy: 'Always',
      command: ['node', '/opt/yaac/helpers/bin/yaac-tree', 'start', '--trigger', TREE_TRIGGER_FILE],
    })
    // Root, with CAP_SYS_ADMIN for its binds and CAP_SETPCAP to drop both
    // for good afterwards; nothing else beyond what owning files needs.
    expect(tree.securityContext).toEqual({
      runAsUser: 0,
      runAsGroup: 0,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'SYS_ADMIN', 'SETPCAP'] },
    })
    // Nothing holds the workspace container back: the claim waits for the
    // tree container's marker instead.
    expect(tree.startupProbe).toBeUndefined()
    // Limits on every container give the pod its memory cap.
    expect(tree.resources).toEqual(TREE_RESOURCES)
    expect(tree.volumeMounts).toEqual([
      { name: 'node-mounts', mountPath: '/node-mounts', readOnly: true, mountPropagation: 'HostToContainer' },
      { name: 'helpers', mountPath: '/opt/yaac/helpers', readOnly: true, subPath: 'run/helpers/build-1' },
      { name: 'tree-trigger', mountPath: TREE_TRIGGER_DIR },
    ])
    expect(pod.terminationGracePeriodSeconds).toBe(PRE_STOP_GRACE_SECONDS + TREE_FINAL_PASS_SECONDS)

    // A site release keeps its files on the shared tier: no tree container.
    const release = build({ treeImage: undefined }).spec.template.spec
    expect(release.initContainers).toBeUndefined()
    expect(release.terminationGracePeriodSeconds).toBe(PRE_STOP_GRACE_SECONDS)
  })

  it('mounts a byo volume\'s claim and hands its fresh root to the pod\'s identity first, from the utility image', () => {
    const pod = build({
      claimMounts: [
        { claimName: 'yaac-vol-v1', mountPath: '/home/yaac/data' },
        { claimName: 'yaac-vol-v2', mountPath: '/srv/cache' },
      ],
      utilityImage: 'registry.local/podman-stable:v5.5',
    }).spec.template.spec
    expect(pod.volumes.slice(-2)).toEqual([
      { name: 'pv-0', persistentVolumeClaim: { claimName: 'yaac-vol-v1' } },
      { name: 'pv-1', persistentVolumeClaim: { claimName: 'yaac-vol-v2' } },
    ])
    expect(pod.containers[0].volumeMounts.slice(-2)).toEqual([
      { name: 'pv-0', mountPath: '/home/yaac/data' },
      { name: 'pv-1', mountPath: '/srv/cache' },
    ])
    // Before the tree container, so the root is the workspace's by the
    // time anything writes there.
    expect(pod.initContainers?.map((c) => c.name)).toEqual(['volume-root', 'tree'])
    const [volumeRoot] = pod.initContainers ?? []
    const { runAsUser, runAsGroup } = installSecurityContext()
    expect(volumeRoot).toMatchObject({
      image: 'registry.local/podman-stable:v5.5',
      securityContext: { runAsUser: 0, runAsGroup: 0 },
      resources: { limits: { cpu: '100m', memory: '64Mi' } },
      volumeMounts: [{ name: 'pv-0', mountPath: '/volumes/pv-0' }, { name: 'pv-1', mountPath: '/volumes/pv-1' }],
    })
    expect(volumeRoot.restartPolicy).toBeUndefined()
    expect(volumeRoot.command?.slice(-3)).toEqual(['--', '/volumes/pv-0', '/volumes/pv-1'])
    // The root alone, and only when it is not the pod's already.
    expect(volumeRoot.command?.[2]).toContain(`chown ${String(runAsUser)}:${String(runAsGroup)} "$d"`)
    expect(volumeRoot.command?.[2]).not.toContain('-R')

    // The workspace's own image could run anything as root there.
    expect(() => build({ claimMounts: [{ claimName: 'yaac-vol-v1', mountPath: '/data' }] })).toThrow(/utilityImage/)
  })

  it('reads run secrets by key from their Secret, so no value is in the Job, refusing one another variable shares', () => {
    const env = build({ secretEnv: { secretName: 'yaac-run-secrets-p1', names: ['P8_KEY', 'API_TOKEN'] } })
      .spec.template.spec.containers[0].env
    expect(env?.slice(-2)).toEqual([
      { name: 'P8_KEY', valueFrom: { secretKeyRef: { name: 'yaac-run-secrets-p1', key: 'P8_KEY' } } },
      { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'yaac-run-secrets-p1', key: 'API_TOKEN' } } },
    ])
    expect(() => build({ secretEnv: { secretName: 'yaac-run-secrets-p1', names: ['X'] } })).toThrow(/run secret X shares its name/)
  })
})
