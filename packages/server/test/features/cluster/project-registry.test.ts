import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Real `sh -n` syntax check (the kubectl execFileAsync here is a mock). */
const runSh = promisify(execFile)

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#platform/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
  sweepLegacyImageStore,
} from '#features/cluster'
// Setup values: label keys, the pinned upstream digest, and the name/path
// derivations the assertions below compare against.
import {
  LABEL_NODE_WRITE,
  LABEL_REGISTRY_DATA_DIR_HASH,
  PROJECT_REGISTRY_PORT,
  REGISTRY_APP_LABEL,
  REGISTRY_IMAGE_DIGEST,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
  REGISTRY_GC_INTERVAL_MS,
  REGISTRY_GENERATIONS_KEPT,
  _registryGcSettledForTests,
  _resetRegistryGcForTests,
  projectRegistryName,
  projectRegistryStorageHostPath,
} from '#features/cluster/project-registry'
import { resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s/kubectl'
import { pushImageToRegistry, registryHasTag } from '#platform/container/registry'
import { imageExists } from '#platform/container/runtime'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const NODE_IP = '10.89.0.7'
// Carries both what project-registry reads (the node name, to pin the writer
// pod) and what the real cluster-cidrs probe reads (the InternalIP the
// ingress policy admits containerd pulls from).
const NODE_LIST = {
  items: [{
    metadata: { name: 'yaac-control-plane' },
    status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] },
  }],
}

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

const appliedAllKind = (kind: string): unknown[] =>
  mockApply.mock.calls.map((c) => c[0] as { kind: string }).filter((m) => m.kind === kind)
const appliedKind = (kind: string): unknown => appliedAllKind(kind)[0]

/**
 * A live cluster for an ensure: the Service has its allocator-assigned
 * ClusterIP, one node answers (which is also what the real cluster-cidrs
 * probe reads for the ingress policy), and the writer pod completed.
 */
function stageLiveCluster(): void {
  resetClusterCidrCache()
  mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
    if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
    if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
    return cidrRead(args) ?? Promise.resolve(null)
  })
}

/**
 * The node read cluster-cidrs resolves the ingress policy's ipBlocks from.
 * Every staged read defers to it so the real probe answers rather than a
 * stubbed sibling.
 */
function cidrRead(args: string[]): Promise<unknown> | null {
  return args[1] === 'nodes' ? Promise.resolve(NODE_LIST) : null
}

describe('projectRegistryHost', () => {
  it('is the registry svc-DNS FQDN with its port, deterministic per slug', () => {
    // FQDN, not the `.svc` shorthand: the proxy forwards only `.cluster.local`.
    expect(projectRegistryHost('demo'))
      .toMatch(/^yaac-reg-demo-[0-9a-f]{8}\.test-ns\.svc\.cluster\.local:5000$/)
    expect(projectRegistryHost('demo')).toBe(projectRegistryHost('demo'))
  })

  it('truncates long slugs but keeps them distinct via the full-slug hash', () => {
    const a = projectRegistryHost('a'.repeat(30) + '-one')
    const b = projectRegistryHost('a'.repeat(30) + '-two')
    expect(a).not.toBe(b)
    // DNS-label cap: prefix(9) + slug(<=21) + dash(1) + hash(8) <= 39.
    expect(a.split('.')[0].length).toBeLessThanOrEqual(39)
  })

  it('sanitizes slugs into DNS-safe names', () => {
    expect(projectRegistryHost('My_Project!')).toMatch(/^yaac-reg-my-project-[0-9a-f]{8}\./)
  })
})

describe('projectRegistryConfDropIn', () => {
  it('renders an insecure drop-in scoped to the exact registry host', () => {
    // Scoped to the one host: a blanket `insecure = true` would apply to
    // every registry the in-pod engine talks to.
    expect(projectRegistryConfDropIn('demo')).toBe([
      '[[registry]]',
      `location = "${projectRegistryHost('demo')}"`,
      'insecure = true',
      '',
    ].join('\n'))
  })
})

describe('ensureProjectRegistry', () => {
  beforeEach(() => {
    mockHasTag.mockResolvedValue(true)
    stageLiveCluster()
  })

  it('applies Deployment, Service, and all network policies, then waits and runs the hosts-writer pod', async () => {
    await ensureProjectRegistry('demo')

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'Deployment', 'Service', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'Pod',
    ])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${projectRegistryName('demo')}`,
        '-n', 'test-ns', '--timeout=120s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    // hosts.toml written by an in-cluster one-shot pod pinned to the node,
    // NOT podman exec — the server's engine need not host the node.
    const pod = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`http://10.96.0.50:${PROJECT_REGISTRY_PORT}`)
    expect(mockExec).not.toHaveBeenCalled()
    // Stray node-write pods from crashed runs are swept by label first —
    // scoped by the marker label so the registry Deployment's pod (same
    // registry labels) is out of reach.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16,${LABEL_NODE_WRITE}`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    // The writer pod (per-run unique name) is pre-cleaned and deleted
    // after completion.
    const namedPodDeletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((a) => a[0] === 'delete' && a[1] === 'pod' && a[2] !== '-l')
    expect(namedPodDeletes).toHaveLength(2)
    for (const args of namedPodDeletes) {
      expect(args[2]).toMatch(
        new RegExp(`^${projectRegistryName('demo')}-hosts-0-[0-9a-f]{8}$`))
    }
    // The ClusterIP is allocator-assigned and never deleted — no migration.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })

  it('serializes concurrent ensures for one project', async () => {
    let releaseRollout!: () => void
    const gate = new Promise<void>((r) => { releaseRollout = r })
    let rollouts = 0
    mockRetry.mockImplementation((args: string[]) => {
      if (args[0] === 'rollout' && ++rollouts === 1) {
        return gate.then(() => ({ stdout: '', stderr: '' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const first = ensureProjectRegistry('demo')
    const second = ensureProjectRegistry('demo')
    await new Promise((r) => setTimeout(r, 10))
    // The second ensure has not started while the first waits on its
    // rollout: only the first's five object applies have happened (its
    // writer pod comes after the rollout).
    expect(mockApply).toHaveBeenCalledTimes(5)

    releaseRollout()
    await Promise.all([first, second])
    expect(mockApply).toHaveBeenCalledTimes(12)
  })

  it('surfaces a failed writer pod with its logs (session create must not proceed)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'read-only file system\n' : '', stderr: '' }))

    await expect(ensureProjectRegistry('demo'))
      .rejects.toThrow(/did not complete \(phase Failed\); logs: read-only file system/)
  })

  it('runs the registry as untrusted-free infra off a node-local hostPath', async () => {
    await ensureProjectRegistry('demo')

    const dep = appliedKind('Deployment') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        replicas: number
        strategy: unknown
        selector: { matchLabels: Record<string, string> }
        template: { spec: {
          automountServiceAccountToken: boolean
          enableServiceLinks: boolean
          runtimeClassName?: string
          priorityClassName?: string
          hostUsers?: boolean
          securityContext?: unknown
          volumes: Array<Record<string, unknown>>
          containers: Array<{
            image: string
            ports: Array<Record<string, unknown>>
            readinessProbe: { httpGet: unknown }
            volumeMounts: Array<Record<string, unknown>>
          }>
        } }
      }
    }
    expect(dep.metadata.name).toBe(projectRegistryName('demo'))
    expect(dep.metadata.namespace).toBe('test-ns')
    expect(dep.spec.replicas).toBe(1)
    // Recreate, not RollingUpdate: two replicas would race on one hostPath.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' })
    const pod = dep.spec.template.spec
    // Trusted yaac infra: no SA token, no service links, runc (no sentry to
    // buy — it runs only the pinned upstream registry image).
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.enableServiceLinks).toBe(false)
    expect(pod.runtimeClassName).toBeUndefined()
    // Infra tier: the project's sessions pull their images from here, so it
    // outranks them when the node runs out of room.
    expect(pod.priorityClassName).toBe('yaac-infra')
    expect(pod.hostUsers).toBeUndefined()
    expect(pod.securityContext).toBeUndefined()
    expect(pod.containers[0].image).toMatch(/^localhost:5001\/yaac-registry2:/)
    expect(pod.containers[0].ports).toEqual([{ containerPort: PROJECT_REGISTRY_PORT }])
    // Storage is node-local and scoped by install hash + slug, like the
    // shared image store.
    expect(JSON.stringify(pod.volumes))
      .toContain(projectRegistryStorageHostPath('demo'))

    const svc = appliedKind('Service') as {
      spec: { ports: Array<{ port: number; targetPort: number }> }
    }
    expect(svc.spec.ports[0].port).toBe(PROJECT_REGISTRY_PORT)
    expect(svc.spec.ports[0].targetPort).toBe(PROJECT_REGISTRY_PORT)
  })

  it('fences the registry to its own project: sessions in, nothing out', async () => {
    await ensureProjectRegistry('demo')

    const nps = appliedAllKind('NetworkPolicy') as unknown as Array<{
      metadata: { name: string; namespace: string }
      spec: {
        podSelector: { matchLabels: Record<string, string>; matchExpressions?: unknown }
        policyTypes: string[]
        egress?: Array<Record<string, unknown>>
        ingress?: Array<{ from?: unknown; ports?: Array<{ protocol: string; port: number }> }>
      }
    }>
    const name = projectRegistryName('demo')

    // Only this project's sessions may egress to this project's registry.
    const sessions = nps.find((m) => m.metadata.name === `${name}-sessions`)!
    expect(sessions.spec.podSelector.matchLabels).toEqual({ 'yaac.project': 'demo' })
    expect(sessions.spec.policyTypes).toEqual(['Egress'])

    // Ingress admits same-project sessions and the node (containerd pulls),
    // the latter by address through the real cluster-cidrs probe.
    const ingress = nps.find((m) => m.metadata.name === `${name}-ingress`)!
    expect(ingress.spec.policyTypes).toEqual(['Ingress'])
    const node = ingress.spec.ingress!.find((r) => JSON.stringify(r.from).includes(NODE_IP))
    expect(node?.ports).toEqual([{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }])

    // The registry pod itself has nothing to fetch, so its egress is empty.
    const egress = nps.find((m) => m.metadata.name === `${name}-egress`)!
    expect(egress.spec.policyTypes).toEqual(['Egress'])
    expect(egress.spec.egress).toEqual([])
  })

  it('mirrors the pinned upstream registry image, pulling only when it is absent', async () => {
    // Already in the local registry — no podman at all.
    mockHasTag.mockResolvedValue(true)
    await ensureProjectRegistry('demo')
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    // Present in podman but not pushed — push without pulling.
    vi.clearAllMocks()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(true)
    await ensureProjectRegistry('demo')
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)

    // Absent everywhere — pull by the multi-arch index digest, tag, push.
    vi.clearAllMocks()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await ensureProjectRegistry('demo')
    expect(REGISTRY_UPSTREAM_IMAGE).toBe(`docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`)
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['pull', REGISTRY_UPSTREAM_IMAGE], expect.objectContaining({ timeout: 300_000 }),
    )
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['tag', REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG],
    )
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)
  })

  it('fails fast instead of pulling when prebuilt images are required', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureProjectRegistry('demo')).rejects.toThrow(/missing/)
    expect(mockExec).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe('removeProjectRegistry', () => {
  function mockClusterWithPodPhase(phase: string, hadRegistry = true): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'deployment,service') {
        return Promise.resolve({ items: hadRegistry ? [{}] : [] })
      }
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase } })
      return Promise.resolve(null)
    })
  }

  it('deletes by label selector scoped to this install and cleans the node via a pod', async () => {
    mockClusterWithPodPhase('Succeeded')
    await removeProjectRegistry('demo')
    // `pod` in the kinds reaps stray writer/cleanup pods from crashed runs.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    const pod = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`/host-certs/${projectRegistryHost('demo')}`)
    expect(script).toContain('/host-storage/demo')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('swallows node-side cleanup failures (cluster recreate)', async () => {
    mockClusterWithPodPhase('Failed')
    await expect(removeProjectRegistry('demo')).resolves.toBeUndefined()
  })

  it('skips the node cleanup pods when the project never had a registry', async () => {
    mockClusterWithPodPhase('Succeeded', false)
    await removeProjectRegistry('demo')
    // The by-selector delete still runs (reaps stray pods from crashes)...
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    // ...but no cleanup pod is applied and no nodes are listed: a pod that
    // can't start (image never mirrored / nested pod guard) would burn the
    // full runNodeWritePod deadline and stall project remove for 60s.
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockGetJson).not.toHaveBeenCalledWith(['get', 'nodes'])
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
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({
          items: [
            { metadata: { labels: { 'yaac.project': 'alive' } } },
            { metadata: { labels: { 'yaac.project': 'gone' } } },
          ],
        })
      }
      if (args[1] === 'deployment,service') return Promise.resolve({ items: [{}] })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })

    await gcOrphanProjectRegistries()

    // Filter to the label-selector object deletes — the cleanup pod's own
    // lifecycle (pre-delete + delete-after) also issues `delete pod` calls.
    const deletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'deployment,service,networkpolicy,pod')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][3]).toContain('yaac.project=gone')
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(gcOrphanProjectRegistries()).resolves.toBeUndefined()
  })
})

describe('reconcileProjectRegistryGc', () => {
  /** One registry serving from `node`, plus the poll a collect pod needs. */
  function registryOn(node: string | undefined): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: { labels: { 'yaac.project': 'demo' } } }] })
      }
      if (args[1] === 'pods') {
        return Promise.resolve({ items: node ? [{ spec: { nodeName: node } }] : [] })
      }
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })
  }
  const kubectlArgs = (): string[][] => mockRetry.mock.calls.map((c) => c[0])
  /** Whether each applied registry Deployment was the read-only one. */
  const rollouts = (): boolean[] => mockApply.mock.calls
    .map((c) => c[0] as { kind: string; spec?: { template?: { spec?: { containers?: Array<
      { env?: Array<{ name: string }> }> } } } })
    .filter((m) => m.kind === 'Deployment')
    .map((m) => (m.spec?.template?.spec?.containers?.[0]?.env ?? [])
      .some((e) => e.name === 'REGISTRY_STORAGE_MAINTENANCE_READONLY'))

  beforeEach(() => {
    _resetRegistryGcForTests()
  })

  /** The step detaches its collect, so tests await the work it started. */
  const gcPass = async (now: number): Promise<void> => {
    await reconcileProjectRegistryGc(now)
    await _registryGcSettledForTests()
  }

  it('collects behind a read-only window, then restores serving mode', async () => {
    registryOn('node-a')
    await gcPass(1_000)

    // Read-only in, serving out. Not scale-to-zero: an active project's
    // session count never reaches zero, and pulls have to keep working.
    expect(rollouts()).toEqual([true, false])
    expect(kubectlArgs().filter((a) => a[0] === 'scale')).toEqual([])
    const pod = mockApply.mock.calls.map((c) => c[0] as {
      kind: string
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        nodeName: string
        containers: Array<{ image: string; command: string[] }>
        volumes: Array<{ hostPath: { path: string } }>
      }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!
    // Pinned to the node holding the store — the storage is node-local.
    expect(pod.spec.nodeName).toBe('node-a')
    expect(pod.spec.volumes[0].hostPath.path).toBe(projectRegistryStorageHostPath('demo'))
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(
      '/bin/registry garbage-collect --delete-untagged=true /etc/docker/registry/config.yml')
    expect(pod.metadata.labels['yaac.node-write']).toBe('gc')

    // Retention runs FIRST: it is what turns a stale content-hash
    // generation into the untagged manifest the collect can then reclaim.
    expect(script.indexOf('retired-generations'))
      .toBeLessThan(script.indexOf('garbage-collect'))
  })

  it('retires only yaac content-hash generations, never a name someone could pull', async () => {
    registryOn('node-a')
    await gcPass(1_000)
    const script = (mockApply.mock.calls.map((c) => c[0] as {
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    // Repo guard keeps a session's own `myapp` repo out of scope. Only the
    // bare spelling: the alias drop above runs first, so a `localhost/`
    // -prefixed repo can no longer be standing here...
    expect(script).toContain('yaac-*) ;;')
    // ...and the tag guard is the content-hash shape, so `v1`, `latest`
    // and the cache's `yaac-cache-…` slots can never match.
    expect(script).toContain("grep -Ex '[0-9a-f]{16}'")
    // Newest-first, keeping current + one rollback (the host-side policy).
    expect(script).toContain('ls -1t')
    expect(script).toContain(`tail -n +${REGISTRY_GENERATIONS_KEPT + 1}`)
  })

  it('drops the legacy localhost/ alias repos before collecting', async () => {
    registryOn('node-a')
    await gcPass(1_000)
    const script = (mockApply.mock.calls.map((c) => c[0] as {
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    // An older salvage pushed podman's `localhost/`-prefixed local names
    // verbatim, so every image the server had also pushed under its bare
    // tag has a second repo here holding a second, differently compressed
    // copy of its layers. Removing the subtree un-references those
    // manifests; the collect below is what reclaims the blobs (marking
    // whatever a surviving repo still names), so the order matters as much
    // as the removal.
    expect(script).toContain(
      'rm -rf /var/lib/registry/docker/registry/v2/repositories/localhost')
    expect(script.indexOf('dropped-alias-repos'))
      .toBeLessThan(script.indexOf('garbage-collect'))
  })

  it('sends valid POSIX shell into the collect pod', async () => {
    registryOn('node-a')
    await gcPass(1_000)
    const script = (mockApply.mock.calls.map((c) => c[0] as {
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    await expect(runSh('sh', ['-n', '-c', script])).resolves.toBeTruthy()
  })

  it('collects a project whose sessions are live — idleness is not required', async () => {
    registryOn('node-a')
    // Nothing about the pass consults session pods: read-only is what
    // makes a concurrent push safe, and a push that 405s is retried.
    await gcPass(1_000)
    expect(rollouts()).toEqual([true, false])
  })

  it('throttles to one collect per project per interval', async () => {
    registryOn('node-a')
    await gcPass(1_000)
    mockApply.mockClear()
    await gcPass(1_000 + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([])
    await gcPass(1_000 + REGISTRY_GC_INTERVAL_MS)
    expect(rollouts()).toEqual([true, false])
  })

  it('restores serving mode when the collect fails', async () => {
    registryOn('node-a')
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: { labels: { 'yaac.project': 'demo' } } }] })
      }
      if (args[1] === 'pods') return Promise.resolve({ items: [{ spec: { nodeName: 'node-a' } }] })
      // The collect pod never reaches Succeeded.
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    await gcPass(1_000)
    // A failed collect must never strand the registry in maintenance mode.
    expect(rollouts()).toEqual([true, false])
  })

  it('runs no collect pod for a registry that has never served', async () => {
    registryOn(undefined)
    await gcPass(1_000)
    expect(rollouts()).toEqual([true, false])
    expect(mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .not.toContain('Pod')
  })

  it('returns without waiting on the collect it starts', async () => {
    registryOn('node-a')
    // Reconcile steps run sequentially, so a step that awaited a collect
    // (two rollouts + a pod run) would stall every later step and every
    // later tick behind it. Hold the first rollout open and check the step
    // has already returned with the registry still in maintenance mode.
    let release = (): void => {}
    const held = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = () => r({ stdout: '', stderr: '' })
    })
    mockRetry.mockImplementation((args: string[]) =>
      args[0] === 'rollout' ? held : Promise.resolve({ stdout: '', stderr: '' }))

    await reconcileProjectRegistryGc(1_000)
    expect(rollouts()).not.toContain(false)

    release()
    await _registryGcSettledForTests()
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(reconcileProjectRegistryGc(1_000)).resolves.toBeUndefined()
  })
})

describe('sweepLegacyImageStore', () => {
  it('removes this install\'s retired image-store dir on every node', async () => {
    mockHasTag.mockResolvedValue(true)
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })

    await sweepLegacyImageStore()

    const pods = mockApply.mock.calls.map((c) => c[0] as {
      spec: {
        nodeName: string
        containers: Array<{ command: string[] }>
        volumes: Array<{ hostPath: { path: string } }>
      }
    })
    expect(pods).toHaveLength(NODE_LIST.items.length)
    // Scoped to this install's subdirectory, mounting the parent so the
    // directory itself goes too.
    expect(pods[0].spec.volumes[0].hostPath.path).toBe('/var/lib/yaac/imagecache')
    expect(pods[0].spec.containers[0].command[2]).toBe("rm -rf '/host-imagecache/ddh16'")
    expect(pods.map((p) => p.spec.nodeName)).toEqual(NODE_LIST.items.map((n) => n.metadata.name))
  })

  it('waits for the mirror image rather than failing the boot path', async () => {
    mockHasTag.mockResolvedValue(false)
    await expect(sweepLegacyImageStore()).resolves.toBeUndefined()
    expect(mockApply).not.toHaveBeenCalled()
  })
})
