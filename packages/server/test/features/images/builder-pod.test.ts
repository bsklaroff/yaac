import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import type * as kubectlModule from '#platform/k8s/kubectl'
import type * as imagePromoterModule from '#features/images/image-promoter'
import type * as registryServiceModule from '#features/cluster/registry-service'

/**
 * spawn fake: records invocations, returns an inert child that closes with
 * `spawnCloseCode` on the next tick. execFile stays real so generated
 * shell scripts can be syntax-checked with `sh -n`.
 */
interface FakeStream {
  on: ReturnType<typeof vi.fn>
  pipe: ReturnType<typeof vi.fn>
  setEncoding: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
interface FakeChild extends EventEmitter {
  stdout: FakeStream
  stderr: FakeStream
  stdin: FakeStream
}
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; child: FakeChild }>)
const spawnState = vi.hoisted(() => ({ closeCode: 0 }))

vi.mock('#features/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  apiserverIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const fakeStream = (): FakeStream => ({
    on: vi.fn(),
    pipe: vi.fn(),
    setEncoding: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  })
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const child = new EventEmitter() as FakeChild
      child.stdout = fakeStream()
      child.stderr = fakeStream()
      child.stdin = fakeStream()
      spawned.push({ file, args, child })
      process.nextTick(() => child.emit('close', spawnState.closeCode))
      return child
    },
  }
})

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
const mockEnsureKubernetes = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
  ensureKubernetes: mockEnsureKubernetes,
}))

const mockEnsureSalvageWriterImage = vi.hoisted(() => vi.fn())
vi.mock('#features/images/image-promoter', async (importOriginal) => ({
  ...(await importOriginal<typeof imagePromoterModule>()),
  ensureSalvageWriterImage: mockEnsureSalvageWriterImage,
}))

// Only vapAvailable is consumed from the (heavy) vcluster module.
const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster/vcluster', () => ({ vapAvailable: mockVapAvailable }))

const mockEnsureRegistryClusterService = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster/registry-service', async (importOriginal) => ({
  ...(await importOriginal<typeof registryServiceModule>()),
  ensureRegistryClusterService: mockEnsureRegistryClusterService,
  registryClusterHost: () => 'yaac-registry.test-ns.svc.cluster.local:5000',
}))

import {
  BUILDER_ACTIVE_DEADLINE_SECONDS,
  BUILDER_CONTEXT_DIR,
  BUILDER_CONTEXT_MAX_BYTES,
  BUILDER_GRAPHROOT_SIZELIMIT_BYTES,
  BUILDER_GRAPHROOT_TMPFS_BYTES,
  BUILDER_MEMORY_LIMIT_BYTES,
  BUILDER_REAP_AGE_MS,
  BuilderPodLease,
  buildBuilderEgressNetworkPolicyManifest,
  buildBuilderPodManifest,
  buildCacheRepo,
  buildLayerInPod,
  ensureBuilderRoleGuard,
  builderBuildArgs,
  builderParentPullScript,
  builderPodBlockReason,
  builderPodName,
  builderStorageConfScript,
  planBuildContext,
  reconcileBuilderPodGc,
  _resetBuilderReapForTests,
} from '#features/images/builder-pod'
import type { ImageLayer } from '#features/images/image-builder'

const execFileAsync = promisify(execFile)

const CLUSTER_HOST = 'yaac-registry.test-ns.svc.cluster.local:5000'

function projectLayer(over: Partial<ImageLayer> = {}): ImageLayer {
  return {
    tag: 'yaac-base:abc123',
    name: 'project',
    dockerfile: '/cfg/Dockerfile.yaac',
    context: '/cfg',
    buildArgs: { BASE_IMAGE: 'yaac-tools:def456' },
    contentHash: 'abc123',
    ...over,
  }
}

/** Shell-syntax-check a generated script. */
async function expectValidSh(script: string): Promise<void> {
  await execFileAsync('sh', ['-n', '-c', script])
}

const tmpDirs: string[] = []
async function makeContext(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-builder-test-'))
  tmpDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content)
  }
  return dir
}

beforeEach(() => {
  vi.clearAllMocks()
  spawned.length = 0
  spawnState.closeCode = 0
  _resetBuilderReapForTests()
  mockVapAvailable.mockResolvedValue(true)
  mockEnsureKubernetes.mockResolvedValue(undefined)
  mockEnsureSalvageWriterImage.mockResolvedValue('localhost:5001/podman-stable:v5.5')
  mockEnsureRegistryClusterService.mockResolvedValue(CLUSTER_HOST)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlGetJson.mockResolvedValue(null)
})

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('builderPodName', () => {
  it('derives a label-safe name from the seed tag plus entropy', () => {
    expect(builderPodName('yaac-base:abc')).toMatch(/^yaac-builder-[0-9a-f]{8}-[0-9a-f]{4}$/)
  })

  it('is stable in prefix, unique in suffix', () => {
    const a = builderPodName('yaac-base:abc')
    const b = builderPodName('yaac-base:abc')
    expect(a.slice(0, -4)).toBe(b.slice(0, -4))
    expect(a).not.toBe(b)
  })
})

describe('buildCacheRepo', () => {
  it('prefixes and passes through a clean slug', () => {
    expect(buildCacheRepo('my-project')).toBe('yaac-buildcache-my-project')
  })

  it('sanitizes to valid OCI repo characters', () => {
    expect(buildCacheRepo('My Project!')).toBe('yaac-buildcache-my-project-')
  })
})

describe('buildBuilderPodManifest', () => {
  const m = () => buildBuilderPodManifest('yaac-builder-aaaa-bbbb', 'localhost:5001/podman-stable:v5.5') as {
    metadata: {
      name: string
      namespace: string
      labels: Record<string, string>
      annotations: Record<string, string>
    }
    spec: {
      restartPolicy: string
      activeDeadlineSeconds: number
      automountServiceAccountToken: boolean
      enableServiceLinks: boolean
      runtimeClassName: string
      securityContext: { seccompProfile: { type: string } }
      containers: Array<{
        image: string
        imagePullPolicy: string
        command: string[]
        securityContext: { capabilities: { add: string[] } }
        resources: { limits: { memory: string } }
        volumeMounts: Array<{ name: string; mountPath: string }>
      }>
      volumes: Array<{ name: string; emptyDir: { sizeLimit: string } }>
    }
  }

  it('is a gvisor pod with the builder role labels', () => {
    const pod = m()
    expect(pod.metadata.name).toBe('yaac-builder-aaaa-bbbb')
    expect(pod.metadata.namespace).toBe('test-ns')
    expect(pod.metadata.labels).toEqual({
      'yaac.data-dir-hash': 'ddh0000000000000',
      'yaac.role': 'builder',
    })
    expect(pod.spec.runtimeClassName).toBe('gvisor')
  })

  it('is bounded and unprivileged pod-side', () => {
    const pod = m()
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.activeDeadlineSeconds).toBe(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(pod.spec.enableServiceLinks).toBe(false)
    expect(pod.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault')
    expect(pod.spec.containers[0].resources.limits.memory)
      .toBe(String(BUILDER_MEMORY_LIMIT_BYTES))
  })

  it('parks on sleep with the nested-engine cap set', () => {
    const pod = m()
    expect(pod.spec.containers[0].command).toEqual(['sleep', 'infinity'])
    expect(pod.spec.containers[0].imagePullPolicy).toBe('IfNotPresent')
    expect(pod.spec.containers[0].securityContext.capabilities.add)
      .toContain('SETFCAP')
  })

  it('backs the graphroot with a 16Gi sentry tmpfs emptyDir', () => {
    const pod = m()
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.type'])
      .toBe('bind')
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.options'])
      .toBe(`rw,size=${BUILDER_GRAPHROOT_TMPFS_BYTES}`)
    expect(pod.spec.volumes).toEqual([{
      name: 'podman-graphroot',
      emptyDir: { sizeLimit: String(BUILDER_GRAPHROOT_SIZELIMIT_BYTES) },
    }])
    expect(pod.spec.containers[0].volumeMounts).toEqual([{
      name: 'podman-graphroot',
      mountPath: '/var/lib/containers',
    }])
  })
})

describe('builderStorageConfScript', () => {
  it('is valid POSIX sh', async () => {
    await expectValidSh(builderStorageConfScript())
  })

  it('selects native overlay (no fuse-overlayfs) and keeps partial pulls', () => {
    const script = builderStorageConfScript()
    expect(script).toContain('driver = "overlay"')
    expect(script).not.toContain('fuse-overlayfs')
    expect(script).toContain('enable_partial_images = "true"')
    expect(script).toContain('graphroot = "/var/lib/containers/storage"')
  })
})

describe('builderParentPullScript', () => {
  it('is valid POSIX sh', async () => {
    await expectValidSh(builderParentPullScript('yaac-tools:def', CLUSTER_HOST))
  })

  it('pulls from the cluster registry and retags to the bare tag', () => {
    const script = builderParentPullScript('yaac-tools:def', CLUSTER_HOST)
    expect(script).toContain(`podman pull --tls-verify=false ${CLUSTER_HOST}/yaac-tools:def`)
    expect(script).toContain(`podman tag ${CLUSTER_HOST}/yaac-tools:def yaac-tools:def`)
    // Pod reuse: the second layer's parent is already local.
    expect(script).toContain('if podman image exists yaac-tools:def; then exit 0; fi')
  })
})

describe('builderBuildArgs', () => {
  const opts = {
    dockerfileRel: 'Dockerfile.yaac',
    clusterHost: CLUSTER_HOST,
    cacheRepo: 'yaac-buildcache-proj',
    noCache: false,
  }

  it('builds with chroot isolation and the registry step cache', () => {
    const args = builderBuildArgs(projectLayer(), opts)
    expect(args.slice(0, 3)).toEqual(['build', '--isolation', 'chroot'])
    expect(args).toContain('--tls-verify=false')
    expect(args).toContain('-t')
    expect(args).toContain('yaac-base:abc123')
    const cacheRef = `${CLUSTER_HOST}/yaac-buildcache-proj`
    expect(args.join(' ')).toContain(`--cache-from ${cacheRef} --cache-to ${cacheRef} --cache-ttl 168h`)
    expect(args.join(' ')).toContain(`-f ${BUILDER_CONTEXT_DIR}/Dockerfile.yaac`)
    expect(args.join(' ')).toContain('--build-arg BASE_IMAGE=yaac-tools:def456')
    expect(args[args.length - 1]).toBe(BUILDER_CONTEXT_DIR)
  })

  it('replaces the cache flags with --no-cache on forced rebuilds', () => {
    const args = builderBuildArgs(projectLayer(), { ...opts, noCache: true })
    expect(args).toContain('--no-cache')
    expect(args.join(' ')).not.toContain('--cache-from')
    expect(args.join(' ')).not.toContain('--cache-to')
  })
})

describe('planBuildContext', () => {
  it('collects the contextHash file set plus the dockerfile', async () => {
    const dir = await makeContext({
      'Dockerfile.yaac': 'FROM x',
      'keep.txt': 'k',
      'skipped/file.txt': 's',
      '.containerignore': 'skipped\n',
    })
    const plan = await planBuildContext(dir, path.join(dir, 'Dockerfile.yaac'))
    expect(plan.dockerfileRel).toBe('Dockerfile.yaac')
    expect(plan.files).toContain('keep.txt')
    expect(plan.files).toContain('.containerignore')
    expect(plan.files).toContain('Dockerfile.yaac')
    expect(plan.files.some((f) => f.startsWith('skipped/'))).toBe(false)
  })

  it('ships the dockerfile even when .containerignore excludes it', async () => {
    const dir = await makeContext({
      'Dockerfile.user': 'FROM x',
      '.containerignore': 'Dockerfile.user\n',
    })
    const plan = await planBuildContext(dir, path.join(dir, 'Dockerfile.user'))
    expect(plan.files).toContain('Dockerfile.user')
  })

  it('rejects a dockerfile outside the context', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x' })
    await expect(planBuildContext(dir, '/elsewhere/Dockerfile'))
      .rejects.toThrow(/outside its build context/)
  })

  it('rejects an oversized context with a .containerignore pointer', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x' })
    // Sparse file: st_size crosses the cap without touching the disk.
    const fh = await fs.open(path.join(dir, 'big.bin'), 'w')
    await fh.truncate(BUILDER_CONTEXT_MAX_BYTES + 1)
    await fh.close()
    await expect(planBuildContext(dir, path.join(dir, 'Dockerfile.yaac')))
      .rejects.toThrow(/\.containerignore/)
  })
})

describe('buildBuilderEgressNetworkPolicyManifest', () => {
  it('allows all egress for role=builder pods', () => {
    const m = buildBuilderEgressNetworkPolicyManifest() as {
      metadata: { name: string; namespace: string }
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        egress: unknown[]
      }
    }
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.spec.podSelector.matchLabels).toEqual({ 'yaac.role': 'builder' })
    expect(m.spec.policyTypes).toEqual(['Egress'])
    expect(m.spec.egress).toEqual([{}])
  })
})

describe('buildLayerInPod', () => {
  function kubectlExecCalls(): string[][] {
    return spawned.filter((s) => s.file === 'kubectl').map((s) => s.args)
  }

  it('provisions a pod, pulls the parent, streams context, builds cached, and pushes', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })

    await buildLayerInPod(layer, { projectSlug: 'proj' })

    // Infra ensured before the pod exists.
    expect(mockEnsureKubernetes).toHaveBeenCalled()
    expect(mockEnsureSalvageWriterImage).toHaveBeenCalled()
    expect(mockEnsureRegistryClusterService).toHaveBeenCalled()
    // Role guard (policy + binding), builder egress NP, pod manifest applied.
    const applied = mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(applied).toContain('ValidatingAdmissionPolicy')
    expect(applied).toContain('ValidatingAdmissionPolicyBinding')
    expect(applied).toContain('NetworkPolicy')
    expect(applied).toContain('Pod')
    // Waited for Ready.
    expect(mockKubectlWithRetry.mock.calls.some((c) => (c[0] as string[])[0] === 'wait')).toBe(true)

    const execs = kubectlExecCalls()
    // storage.conf bootstrap, parent pull, extract, build, push — in order.
    expect(execs).toHaveLength(5)
    const remote = execs.map((args) => args.slice(args.indexOf('--') + 1))
    expect(remote[0][2]).toContain('storage.conf')
    expect(remote[1][2]).toContain('podman pull --tls-verify=false')
    expect(remote[2][2]).toContain(`tar -xf - -C ${BUILDER_CONTEXT_DIR}`)
    expect(remote[3][0]).toBe('podman')
    expect(remote[3]).toContain('--isolation')
    expect(remote[3].join(' ')).toContain('--cache-from')
    expect(remote[4].slice(0, 3)).toEqual(['podman', 'push', '--tls-verify=false'])
    expect(remote[4]).toContain(`${CLUSTER_HOST}/${layer.tag}`)
    // tar producer ran against the context dir.
    expect(spawned.some((s) => s.file === 'tar')).toBe(true)
    // Owned lease: the pod is deleted afterwards.
    expect(mockKubectlWithRetry.mock.calls.some((c) => (c[0] as string[])[0] === 'delete')).toBe(true)
  })

  it('skips the parent pull for a standalone (parentless) layer', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM ubuntu\n' })
    const layer = projectLayer({
      dockerfile: path.join(dir, 'Dockerfile.yaac'),
      context: dir,
      buildArgs: { YAAC_UID: '1000' },
    })
    await buildLayerInPod(layer, { projectSlug: 'proj' })
    const scripts = kubectlExecCalls()
      .map((args) => args.slice(args.indexOf('--') + 1).join(' '))
    expect(scripts.some((s) => s.includes('podman pull'))).toBe(false)
    expect(scripts.some((s) => s.includes('--build-arg YAAC_UID=1000'))).toBe(true)
  })

  it('reuses the leased pod across adjacent layers and releases once', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' })
    const projLayer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    const userLayer = projectLayer({
      tag: 'yaac-user-proj:u1',
      name: 'user',
      dockerfile: path.join(dir, 'Dockerfile.yaac'),
      context: dir,
      buildArgs: { BASE_IMAGE: 'yaac-base:abc123' },
    })

    const lease = new BuilderPodLease()
    await buildLayerInPod(projLayer, { projectSlug: 'proj', lease })
    await buildLayerInPod(userLayer, { projectSlug: 'proj', lease })

    // One pod applied, one storage bootstrap, no delete yet.
    const podApplies = mockKubectlApply.mock.calls
      .filter((c) => (c[0] as { kind: string }).kind === 'Pod')
    expect(podApplies).toHaveLength(1)
    expect(mockKubectlWithRetry.mock.calls.filter((c) => (c[0] as string[])[0] === 'delete'))
      .toHaveLength(0)

    await lease.release()
    const deletes = mockKubectlWithRetry.mock.calls
      .filter((c) => (c[0] as string[])[0] === 'delete')
    expect(deletes).toHaveLength(1)
    expect((deletes[0][0] as string[])).toContain(
      (podApplies[0][0] as { metadata: { name: string } }).metadata.name,
    )
  })

  it('deletes a pod whose provisioning failed after apply', async () => {
    mockKubectlWithRetry.mockImplementation((args: string[]) => {
      if (args[0] === 'wait') return Promise.reject(new Error('timed out'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    await expect(buildLayerInPod(layer, { projectSlug: 'proj' })).rejects.toThrow('timed out')
    expect(mockKubectlWithRetry.mock.calls.some((c) => (c[0] as string[])[0] === 'delete')).toBe(true)
  })

  it('explains a Ready timeout the pod status can account for', async () => {
    // A bare `kubectl wait` timeout reads as a broken build; the node
    // refusing to schedule the pod is the far likelier cause.
    mockKubectlWithRetry.mockImplementation((args: string[]) => {
      if (args[0] === 'wait') return Promise.reject(new Error('timed out'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    mockKubectlGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pod'
        ? {
          status: {
            conditions: [{
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/1 nodes are available: 1 Insufficient memory.',
            }],
          },
        }
        : null,
    ))
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    await expect(buildLayerInPod(layer, { projectSlug: 'proj' }))
      .rejects.toThrow(/Insufficient memory/)
  })

  it('fails closed when the ValidatingAdmissionPolicy API is unavailable', async () => {
    mockVapAvailable.mockResolvedValue(false)
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    await expect(buildLayerInPod(layer, { projectSlug: 'proj' }))
      .rejects.toThrow(/ValidatingAdmissionPolicy/)
    // Without the guard the builder role label is forgeable — no pod may
    // be created.
    expect(mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .not.toContain('Pod')
  })

  it('maps an unreachable cluster to a `yaac cluster check` pointer', async () => {
    mockEnsureKubernetes.mockRejectedValue(new Error('no cluster'))
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    await expect(buildLayerInPod(layer, { projectSlug: 'proj' }))
      .rejects.toThrow(/yaac cluster check/)
  })

  it('refreshes the world-deny policy only when it already exists', async () => {
    mockKubectlGetJson.mockResolvedValue({ kind: 'NetworkPolicy' })
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x\n' })
    const layer = projectLayer({ dockerfile: path.join(dir, 'Dockerfile.yaac'), context: dir })
    await buildLayerInPod(layer, { projectSlug: 'proj' })
    const kinds = mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toContain('NetworkPolicy')
  })
})

describe('ensureBuilderRoleGuard', () => {
  it('applies the cluster-wide guard policy and binding', async () => {
    await ensureBuilderRoleGuard()
    expect(mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .toEqual(['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'])
  })

  it('throws with a setup pointer when the VAP API is missing', async () => {
    mockVapAvailable.mockResolvedValue(false)
    await expect(ensureBuilderRoleGuard()).rejects.toThrow(/yaac cluster setup/)
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })
})

describe('builderPodBlockReason', () => {
  it('names an unschedulable pod and quotes the scheduler', () => {
    expect(builderPodBlockReason({
      status: {
        conditions: [{
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/1 nodes are available: 1 Insufficient memory.',
        }],
      },
    })).toBe('not scheduled (Unschedulable): 0/1 nodes are available: 1 Insufficient memory.')
  })

  it('names a container stuck waiting', () => {
    expect(builderPodBlockReason({
      status: {
        conditions: [{ type: 'PodScheduled', status: 'True' }],
        containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
      },
    })).toBe('container waiting (ImagePullBackOff)')
  })

  it('says nothing when the status explains nothing', () => {
    expect(builderPodBlockReason(null)).toBeNull()
    expect(builderPodBlockReason({ status: {} })).toBeNull()
  })
})

describe('reconcileBuilderPodGc', () => {
  const NOW = 1_800_000_000_000
  /** This server process started 10 minutes ago. */
  const STARTED = NOW - 600_000

  function podItem(name: string, phase: string, ageMs: number): unknown {
    return {
      metadata: { name, creationTimestamp: new Date(NOW - ageMs).toISOString() },
      status: { phase },
    }
  }

  it('reaps terminal pods and over-age runners, keeps live builds', async () => {
    mockKubectlGetJson.mockResolvedValue({
      items: [
        podItem('yaac-builder-dead-0001', 'Failed', 60_000),
        podItem('yaac-builder-done-0002', 'Succeeded', 60_000),
        podItem('yaac-builder-leak-0003', 'Running', BUILDER_REAP_AGE_MS + 60_000),
        podItem('yaac-builder-live-0004', 'Running', 60_000),
      ],
    })
    await reconcileBuilderPodGc(NOW, STARTED)
    const deleted = mockKubectlWithRetry.mock.calls
      .filter((c) => (c[0] as string[])[0] === 'delete')
      .map((c) => (c[0] as string[])[2])
    expect(deleted).toEqual([
      'yaac-builder-dead-0001',
      'yaac-builder-done-0002',
      'yaac-builder-leak-0003',
    ])
  })

  it('reaps a young pod that predates this server process', async () => {
    // A restart orphans the in-flight build's pod. Waiting for the age gate
    // parks its 8 GiB reservation on the node, and the next build cannot
    // schedule until the dead pod's active deadline fires.
    mockKubectlGetJson.mockResolvedValue({
      items: [
        podItem('yaac-builder-orph-0001', 'Running', 700_000),
        podItem('yaac-builder-live-0002', 'Running', 60_000),
      ],
    })
    await reconcileBuilderPodGc(NOW, STARTED)
    const deleted = mockKubectlWithRetry.mock.calls
      .filter((c) => (c[0] as string[])[0] === 'delete')
      .map((c) => (c[0] as string[])[2])
    expect(deleted).toEqual(['yaac-builder-orph-0001'])
  })

  it('scopes the sweep to this install\'s builder pods', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await reconcileBuilderPodGc(NOW, STARTED)
    const args = mockKubectlGetJson.mock.calls[0][0] as string[]
    expect(args).toContain('-l')
    expect(args[args.indexOf('-l') + 1])
      .toBe('yaac.role=builder,yaac.data-dir-hash=ddh0000000000000')
  })

  it('is throttled between sweeps', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await reconcileBuilderPodGc(NOW, STARTED)
    await reconcileBuilderPodGc(NOW + 1000, STARTED)
    expect(mockKubectlGetJson).toHaveBeenCalledTimes(1)
  })

  it('survives an unreachable cluster', async () => {
    mockKubectlGetJson.mockRejectedValue(new Error('down'))
    await expect(reconcileBuilderPodGc(NOW, STARTED)).resolves.toBeUndefined()
  })
})
