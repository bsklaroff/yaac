import { describe, it, expect } from 'vitest'
import {
  CA_CONFIGMAP_NAME,
  installSecurityContext,
  sentryTmpfsAnnotations,
} from '#drivers/k8s/substrate'
import { buildPodJobManifest } from '#drivers/k8s/workspaces'
// Internals, for fixtures and bounds only.
import {
  CA_MOUNT_DIR,
  SCRATCH_REQUEST_BYTES,
  SCRATCH_SIZELIMIT_SLACK_BYTES,
  WORKSPACE_POD_ANNOTATIONS,
  type PodJobParams,
} from '#drivers/k8s/workspaces/pod-job'

function params(overrides: Partial<PodJobParams> = {}): PodJobParams {
  return {
    jobName: 'yaac-demo-abcd',
    namespace: 'test-ns',
    labels: {
      'yaac.project-id': 'demo',
      'yaac.workspace-id': 'abcd',
      'yaac.install-id': 'test-install',
    },
    image: 'localhost:5000/yaac-tools:abc',
    env: ['YAAC_SESSION_ID=abcd', 'X=a=b'],
    mounts: [],
    memoryRequestBytes: 1 * 1024 ** 3,
    memoryLimitBytes: 8 * 1024 ** 3,
    cpuRequestMillis: 250,
    cpuLimitMillis: 8000,
    ephemeralStorageRequestBytes: 2 * 1024 ** 3,
    ephemeralStorageLimitBytes: 16 * 1024 ** 3,
    // The proxy Service's ClusterIP, never a DNS name.
    proxyHost: '10.96.0.179',
    builderImage: 'registry.local/podman-stable:v5.5',
    ...overrides,
  }
}

interface Manifest {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    backoffLimit: number
    template: {
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> }
      spec: {
        restartPolicy: string
        terminationGracePeriodSeconds: number
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        hostUsers?: boolean
        runtimeClassName?: string
        priorityClassName?: string
        topologySpreadConstraints?: Array<{
          maxSkew: number
          topologyKey: string
          whenUnsatisfiable: string
          labelSelector: { matchLabels: Record<string, string> }
        }>
        dnsPolicy?: string
        dnsConfig?: { nameservers: string[] }
        securityContext: { seccompProfile: { type: string }; fsGroup?: number }
        initContainers?: Array<{
          name: string
          image: string
          imagePullPolicy: string
          restartPolicy?: string
          command?: string[]
          securityContext: {
            runAsUser?: number
            allowPrivilegeEscalation?: boolean
            capabilities?: { add?: string[]; drop?: string[] }
          }
          env: Array<{ name: string; value: string }>
          startupProbe?: { exec: { command: string[] } }
          volumeMounts?: Array<{ name: string; mountPath: string }>
          resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
        }>
        containers: Array<{
          name: string
          image: string
          imagePullPolicy: string
          workingDir: string
          env: Array<{ name: string; value: string }>
          securityContext?: {
            capabilities?: { add?: string[] }
            allowPrivilegeEscalation?: boolean
          }
          lifecycle?: { postStart?: { exec?: { command: string[] } } }
          volumeMounts: Array<{
            name: string
            mountPath: string
            subPath?: string
            readOnly?: boolean
          }>
          resources: { requests: Record<string, string>; limits: Record<string, string> }
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
          emptyDir?: { medium?: string; sizeLimit?: string }
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
  it('builds a single-shot Job: backoffLimit 0, restartPolicy Never', () => {
    const m = build()
    expect(m.apiVersion).toBe('batch/v1')
    expect(m.kind).toBe('Job')
    expect(m.spec.backoffLimit).toBe(0)
    expect(m.spec.template.spec.restartPolicy).toBe('Never')
  })

  it('sets name/namespace and applies labels to both the Job and the pod template', () => {
    const m = build()
    expect(m.metadata.name).toBe('yaac-demo-abcd')
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.metadata.labels).toEqual(params().labels)
    expect(m.spec.template.metadata.labels).toEqual(params().labels)
  })

  it('hardens the pod: no service account token, no service links', () => {
    const spec = build().spec.template.spec
    expect(spec.automountServiceAccountToken).toBe(false)
    expect(spec.enableServiceLinks).toBe(false)
  })

  it('hardens the pod: default seccomp profile, and runs as the host identity', () => {
    const spec = build().spec.template.spec
    // Runs as the install's uid so it can write the server-created checkout;
    // group 0 makes the image's files writable (docs/arbitrary-uid-images.md).
    expect(spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
      runAsUser: process.getuid?.(),
      runAsGroup: process.getgid?.(),
      supplementalGroups: [0],
    })
    // No fsGroup, which kubelet would apply to every volume, and no added
    // capabilities.
    expect(spec.securityContext).not.toHaveProperty('fsGroup')
    expect(spec.containers[0].securityContext).toBeUndefined()
  })

  it('host pod: stamps the gvisor RuntimeClass and no user namespace', () => {
    const spec = build().spec.template.spec
    expect(spec.runtimeClassName).toBe('gvisor')
    // gVisor provides the isolation, so no hostUsers key.
    expect(spec.hostUsers).toBeUndefined()
  })

  it('defaults terminationGracePeriodSeconds to 5 and honors an override', () => {
    expect(build().spec.template.spec.terminationGracePeriodSeconds).toBe(5)
    expect(
      build({ terminationGracePeriodSeconds: 30 }).spec.template.spec.terminationGracePeriodSeconds,
    ).toBe(30)
  })

  it('configures the session container: image, pull policy, workdir, requests/limits', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.name).toBe('workspace')
    expect(c.image).toBe('localhost:5000/yaac-tools:abc')
    expect(c.imagePullPolicy).toBe('IfNotPresent')
    expect(c.workingDir).toBe('/workspace')
    // Every resource is requested, so the scheduler counts the pod.
    expect(c.resources.requests).toEqual({
      cpu: '250m',
      memory: String(1 * 1024 ** 3),
      'ephemeral-storage': String(2 * 1024 ** 3),
    })
    // Every resource is capped. The cpu limit is far above the request so it
    // only binds on parallel bursts; under gVisor it also bounds the sandbox's
    // systrap stubs.
    expect(c.resources.limits).toEqual({
      cpu: '8000m',
      memory: String(8 * 1024 ** 3),
      'ephemeral-storage': String(16 * 1024 ** 3),
    })
    expect(Number(c.resources.limits.cpu.replace('m', '')))
      .toBeGreaterThan(Number(c.resources.requests.cpu.replace('m', '')))
  })

  it('puts session pods on the low-priority tier', () => {
    // Infra outranks workspaces, so a full node evicts a workspace first.
    expect(build().spec.template.spec.priorityClassName).toBe('yaac-workspace')
  })

  it('prefers spreading the install\'s workspaces across nodes, never blocking on it', () => {
    // Selects every workspace of this install, so the count per node evens
    // out across projects; ScheduleAnyway keeps a lopsided cluster schedulable.
    expect(build().spec.template.spec.topologySpreadConstraints).toEqual([{
      maxSkew: 1,
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'ScheduleAnyway',
      labelSelector: { matchLabels: { 'yaac.install-id': 'test-install' } },
    }])
  })

  it('parses env entries, preserving equals signs inside values and rendering each name once', () => {
    // Split at the first `=`; a bare name or trailing `=` is an empty value.
    // A server-side apply refuses a repeated name, so an identical repeat is
    // dropped and a conflicting one refused before it gets that far.
    const c = build({ env: ['YAAC_SESSION_ID=abcd', 'X=a=b', 'BARE', 'EMPTY=', 'X=a=b'] })
      .spec.template.spec.containers[0]
    expect(c.env).toEqual([
      { name: 'YAAC_SESSION_ID', value: 'abcd' },
      { name: 'X', value: 'a=b' },
      { name: 'BARE', value: '' },
      { name: 'EMPTY', value: '' },
    ])
    expect(() => build({ env: ['OPENROUTER_API_KEY=a', 'OPENROUTER_API_KEY=b'] }))
      .toThrow('environment variable OPENROUTER_API_KEY is set to two different values')
  })

  it('renders hostPath mounts with the Directory default, File, and "" types', () => {
    const m = build({
      mounts: [
        { source: { kind: 'hostPath', path: '/host/dir' }, mountPath: '/workspace' },
        {
          source: { kind: 'hostPath', path: '/host/file.json', type: 'File' },
          mountPath: '/home/yaac/.claude.json',
        },
        { source: { kind: 'hostPath', path: '/host/any', type: '' }, mountPath: '/mnt/any' },
      ],
    })
    const { volumes, containers } = m.spec.template.spec
    expect(volumes[0]).toEqual({ name: 'hp-0', hostPath: { path: '/host/dir', type: 'Directory' } })
    expect(volumes[1]).toEqual({ name: 'hp-1', hostPath: { path: '/host/file.json', type: 'File' } })
    expect(volumes[2]).toEqual({ name: 'hp-2', hostPath: { path: '/host/any', type: '' } })
    expect(containers[0].volumeMounts.slice(0, 3)).toEqual([
      { name: 'hp-0', mountPath: '/workspace' },
      { name: 'hp-1', mountPath: '/home/yaac/.claude.json' },
      { name: 'hp-2', mountPath: '/mnt/any' },
    ])
  })

  it('renders every mount source, leaving the container-side paths identical', () => {
    // Only the source varies (node disk, the global claim, or pod-local
    // scratch, chosen per tier by `resolveMountSource`).
    const m = build({
      mounts: [
        { source: { kind: 'hostPath', path: '/host/dir' }, mountPath: '/workspace' },
        {
          source: { kind: 'pvc', claimName: 'yaac-shared', subPath: 'projects/demo/claude' },
          mountPath: '/home/yaac/.claude',
        },
        { source: { kind: 'pvc', claimName: 'yaac-shared' }, mountPath: '/mnt/whole-claim' },
        { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' },
        { source: { kind: 'emptyDir', sizeLimit: 2 * 1024 ** 3 }, mountPath: '/mnt/scratch' },
      ],
    })
    const { volumes, containers } = m.spec.template.spec
    // Names carry the source kind and position, so sources never collide.
    expect(volumes.slice(0, 5)).toEqual([
      { name: 'hp-0', hostPath: { path: '/host/dir', type: 'Directory' } },
      // Each mount of a claim has its own volume and subPath.
      { name: 'pv-1', persistentVolumeClaim: { claimName: 'yaac-shared' } },
      { name: 'pv-2', persistentVolumeClaim: { claimName: 'yaac-shared' } },
      { name: 'ed-3', emptyDir: {} },
      { name: 'ed-4', emptyDir: { sizeLimit: String(2 * 1024 ** 3) } },
    ])
    expect(containers[0].volumeMounts.slice(0, 5)).toEqual([
      { name: 'hp-0', mountPath: '/workspace' },
      { name: 'pv-1', mountPath: '/home/yaac/.claude', subPath: 'projects/demo/claude' },
      // No subPath when the whole claim is mounted.
      { name: 'pv-2', mountPath: '/mnt/whole-claim' },
      { name: 'ed-3', mountPath: '/tmp/yaac-tmux' },
      { name: 'ed-4', mountPath: '/mnt/scratch' },
    ])
  })

  it('marks readOnly mounts on any source and omits the key otherwise', () => {
    const m = build({
      mounts: [
        { source: { kind: 'hostPath', path: '/ro' }, mountPath: '/mnt/ro', readOnly: true },
        { source: { kind: 'hostPath', path: '/rw' }, mountPath: '/mnt/rw' },
        {
          source: { kind: 'pvc', claimName: 'yaac-shared', subPath: 'skills' },
          mountPath: '/mnt/skills',
          readOnly: true,
        },
      ],
    })
    const mounts = m.spec.template.spec.containers[0].volumeMounts
    expect(mounts[0]).toEqual({ name: 'hp-0', mountPath: '/mnt/ro', readOnly: true })
    expect(mounts[1]).toEqual({ name: 'hp-1', mountPath: '/mnt/rw' })
    expect(mounts[2]).toEqual({
      name: 'pv-2', mountPath: '/mnt/skills', subPath: 'skills', readOnly: true,
    })
  })

  it('wires postStartExec as the session container postStart hook', () => {
    const c = build({ postStartExec: ['/usr/local/bin/yaac-workspace-init'] })
      .spec.template.spec.containers[0]
    expect(c.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-workspace-init'] } },
    })
  })

  it('wires preStopExec as the preStop hook, beside or without postStart', () => {
    const both = build({
      postStartExec: ['/usr/local/bin/yaac-workspace-init'],
      preStopExec: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'],
    }).spec.template.spec.containers[0]
    expect(both.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-workspace-init'] } },
      preStop: { exec: { command: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'] } },
    })
    const only = build({ preStopExec: ['x'] }).spec.template.spec.containers[0]
    expect(only.lifecycle).toEqual({ preStop: { exec: { command: ['x'] } } })
  })

  it('limits every container, init included, so kubelet caps the pod cgroup gVisor relies on', () => {
    const m = build({
      mounts: [{ source: { kind: 'pvc', claimName: 'yaac-volume-v1' }, mountPath: '/home/yaac/volume' }],
      treeContainer: { image: 'base:1', life: 'L', mounts: [], own: [] },
    })
    const { initContainers = [], containers } = m.spec.template.spec
    expect(initContainers.map((c) => c.name)).toEqual(['volume-root', 'tree'])
    for (const c of [...initContainers, ...containers]) {
      expect(Object.keys(c.resources?.limits ?? {}), c.name).toEqual(expect.arrayContaining(['memory', 'cpu']))
    }
  })

  it('hands a byo volume\'s fresh root to the pod\'s identity in an init container of its own, and nothing else', () => {
    const spec = build({
      mounts: [
        { source: { kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/cache' }, mountPath: '/cache' },
        { source: { kind: 'pvc', claimName: 'yaac-volume-v1' }, mountPath: '/home/yaac/volume' },
      ],
    }).spec.template.spec
    const { runAsUser, runAsGroup } = installSecurityContext()
    expect(spec.initContainers).toEqual([expect.objectContaining({
      name: 'volume-root',
      image: 'registry.local/podman-stable:v5.5',
      securityContext: { runAsUser: 0, runAsGroup: 0 },
      command: ['sh', '-c', expect.stringContaining(`chown ${String(runAsUser)}:${String(runAsGroup)}`), '--', '/volumes/pv-1'],
      volumeMounts: [{ name: 'pv-1', mountPath: '/volumes/pv-1' }],
    })])
    // Never fsGroup, which kubelet would apply to the shared tier too.
    expect(spec.securityContext.fsGroup).toBeUndefined()
    // Root there runs the pinned builder image or nothing.
    expect(() => build({
      mounts: [{ source: { kind: 'pvc', claimName: 'yaac-volume-v1' }, mountPath: '/home/yaac/volume' }],
      builderImage: undefined,
    })).toThrow(/builderImage/)
  })

  it('emits no lifecycle block without postStartExec', () => {
    expect(build().spec.template.spec.containers[0].lifecycle).toBeUndefined()
  })

  it('injects no per-pod egress sidecars — egress is redirected at the cluster level', () => {
    const spec = build().spec.template.spec
    expect(spec.initContainers).toBeUndefined()
    // No added capabilities.
    expect(spec.containers[0]).not.toHaveProperty('securityContext')
  })

  it('points the pod resolver at the proxy VIP DNS stub (dnsPolicy None)', () => {
    const spec = build().spec.template.spec
    expect(spec.dnsPolicy).toBe('None')
    expect(spec.dnsConfig).toEqual({ nameservers: ['10.96.0.179'] })
  })

  it('never leaks a relay token into the session container env', () => {
    const spec = build().spec.template.spec
    const sessionEnvNames = spec.containers[0].env.map((e) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
  })

  it('never emits hostAliases (in-cluster names resolve via the proxy DNS)', () => {
    const spec = build().spec.template.spec
    expect(spec).not.toHaveProperty('hostAliases')
  })

  it('always appends the proxy-CA ConfigMap volume mounted read-only at the CA dir', () => {
    const m = build()
    const { volumes, containers } = m.spec.template.spec
    expect(volumes).toContainEqual({
      name: 'proxy-ca',
      configMap: { name: CA_CONFIGMAP_NAME },
    })
    expect(containers[0].volumeMounts).toContainEqual({
      name: 'proxy-ca',
      mountPath: CA_MOUNT_DIR,
      readOnly: true,
    })
  })

  describe('scratchDirs', () => {
    const GIB = 1024 ** 3
    const scratchDirs = [
      { path: '/workspace/node_modules', sizeBytes: 8 * GIB },
      { path: '/workspace/target', sizeBytes: 32 * GIB },
    ]

    // One volume per dir: the tmpfs annotation applies per volume, not to
    // a subPath. Each is capped at its own size.
    it('backs each dir with its own sentry-tmpfs emptyDir at its own cap', () => {
      const m = build({ scratchDirs })
      const spec = m.spec.template.spec
      expect(spec.volumes).toContainEqual({
        name: 'scratch-0', emptyDir: { sizeLimit: String(8 * GIB + SCRATCH_SIZELIMIT_SLACK_BYTES) },
      })
      expect(spec.volumes).toContainEqual({
        name: 'scratch-1', emptyDir: { sizeLimit: String(32 * GIB + SCRATCH_SIZELIMIT_SLACK_BYTES) },
      })
      expect(spec.containers[0].volumeMounts).toContainEqual({
        name: 'scratch-0', mountPath: '/workspace/node_modules',
      })
      expect(spec.containers[0].volumeMounts).toContainEqual({
        name: 'scratch-1', mountPath: '/workspace/target',
      })
      expect(m.spec.template.metadata.annotations).toEqual({
        ...WORKSPACE_POD_ANNOTATIONS,
        ...sentryTmpfsAnnotations('scratch-0', 8 * GIB),
        ...sentryTmpfsAnnotations('scratch-1', 32 * GIB),
      })
      expect(spec.initContainers).toBeUndefined()
    })

    it('grows the ephemeral-storage request by one install and the limit by every dir\'s ceiling', () => {
      const { resources } = build({ scratchDirs }).spec.template.spec.containers[0]
      expect(resources.requests['ephemeral-storage'])
        .toBe(String(2 * 1024 ** 3 + SCRATCH_REQUEST_BYTES))
      expect(resources.limits['ephemeral-storage'])
        .toBe(String(16 * GIB + 40 * GIB + 2 * SCRATCH_SIZELIMIT_SLACK_BYTES))
    })

    it('leaves a pod with none exactly as it was', () => {
      expect(build({ scratchDirs: [] })).toEqual(build())
      expect(build().spec.template.metadata.annotations).toEqual(WORKSPACE_POD_ANNOTATIONS)
    })
  })

  // docs/node-local-workspaces.md "The tree container".
  it('runs the tree container as the pod\'s one init container: a sidecar that owns the node-local folders and holds the workspace back until its tree is filled', () => {
    const m = build({
      treeContainer: {
        image: 'base:1',
        life: '2026-11-14T00-00-00.000Z',
        mounts: [
          { source: { kind: 'hostPath', path: '/var/lib/yaac/node/i/projects/p/trees/w/L/tree' }, mountPath: '/tree' },
          { source: { kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/p/checkpoints/w' }, mountPath: '/ckpt' },
          { source: { kind: 'hostPath', path: '/var/lib/yaac/node/i/projects/p/opencode-data/w', type: 'DirectoryOrCreate' }, mountPath: '/own/0' },
        ],
        own: ['/own/0'],
      },
    })
    const spec = m.spec.template.spec as unknown as {
      initContainers: Array<Record<string, unknown> & { name: string; volumeMounts: Array<{ name: string; mountPath: string; subPath?: string }> }>
      containers: Array<{ volumeMounts: Array<{ mountPath: string }> }>
      volumes: Array<{ name: string; emptyDir?: unknown }>
    }
    // Nothing in the pod runs as root over more of the node than these
    // mounts: no init container before it, and no volume above a leaf.
    expect(spec.initContainers).toHaveLength(1)
    expect((spec.volumes as Array<{ hostPath?: { path: string } }>).flatMap((v) => (v.hostPath ? [v.hostPath.path] : []))).toEqual([
      '/var/lib/yaac/node/i/projects/p/trees/w/L/tree',
      '/var/lib/yaac/node/i/projects/p/opencode-data/w',
    ])
    const tree = spec.initContainers[0]
    expect(tree).toMatchObject({
      name: 'tree',
      image: 'base:1',
      restartPolicy: 'Always',
      securityContext: { runAsUser: 0, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'] } },
      startupProbe: { exec: { command: ['yaac-tree', 'probe', '--scratch', '/scratch', '--life', '2026-11-14T00-00-00.000Z'] } },
    })
    expect(tree.command).toContain('--life')
    // The folders it hands to the install uid besides its own two.
    expect((tree.command as string[]).slice(-2)).toEqual(['--own', '/own/0'])
    expect(tree.volumeMounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ mountPath: '/tree' }),
      expect.objectContaining({ mountPath: '/own/0' }),
      expect.objectContaining({ mountPath: '/ckpt', subPath: 'projects/p/checkpoints/w' }),
      expect.objectContaining({ name: 'tree-trigger', mountPath: '/yaac-trigger' }),
    ]))
    // Both containers share the trigger, the workspace touching it after a save.
    expect(spec.containers[0].volumeMounts).toContainEqual(expect.objectContaining({ mountPath: '/yaac-trigger' }))
    expect(spec.volumes.find((v) => v.name === 'tree-trigger')?.emptyDir).toBeDefined()
    expect(build().spec.template.spec).not.toHaveProperty('initContainers')
  })
})
