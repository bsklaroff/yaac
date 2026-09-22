import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// Mocked at the process boundary: kubectl is the only way a launch reaches
// the cluster, so the manifest it applies is built for real and asserted on.
const mockApply = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlApply: mockApply,
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'yaac'),
}))

// The transport token is derived through the relay's own crypto path.
vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof streamRelayModule>()),
  podStreamToken: vi.fn().mockResolvedValue('stream-token'),
}))

// The PriorityClass ensure is its own apply chain against the cluster; the
// launch only has to run it BEFORE the Job, which the argv order proves.
const mockEnsurePriorityClasses = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/priority-classes', async (importOriginal) => ({
  ...(await importOriginal<typeof priorityClassesModule>()),
  ensurePriorityClasses: mockEnsurePriorityClasses,
}))

// The proxy's bootstrap is a rollout of its own; the registration it is
// then handed is a ConfigMap, applied through the same kubectl mock as the
// Job, so what a create tells the proxy is asserted on the manifest.
const mockEnsureRunning = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/egress/proxy-client', () => ({
  proxyClient: {
    ensureRunning: mockEnsureRunning,
    getCaTrustEnv: () => ['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem'],
  },
}))

// The cluster half is a whole subprocess tree per call (registry pods,
// node writes) — its boundary is the barrel.
const mockProxyClusterIp = vi.hoisted(() => vi.fn().mockResolvedValue('10.96.0.5'))
const mockEnsureProjectRegistry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  proxyServiceClusterIp: mockProxyClusterIp,
  ensureProjectRegistry: mockEnsureProjectRegistry,
}))

// The node image store is written by cleanup/write pods of its own.
const mockStoreMount = vi.hoisted(() => vi.fn())
const mockEnsureStore = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/store-writer', () => ({
  nodeImageStoreMount: mockStoreMount,
  ensureNodeImageStore: mockEnsureStore,
}))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}))

import type * as priorityClassesModule from '#drivers/k8s/substrate/priority-classes'
import type * as streamRelayModule from '#drivers/k8s/substrate/stream-relay'
import type * as clusterModule from '#drivers/k8s/cluster'
import { launchWorkspace, prepareWorkspaceSubstrate } from '#drivers/k8s/worktrees/launch'
import type { WorkspaceSpec, WorkspaceSubstrate } from '#drivers/contract'

const INTENT = {
  projectSlug: 'proj',
  workspaceId: 's1',
  tool: 'claude' as const,
  config: {},
  remoteUrl: 'https://github.com/example/repo.git',
  nestedContainers: false,
  proxySecretRules: {},
}

function specOf(
  substrate: WorkspaceSubstrate,
  overrides: Partial<WorkspaceSpec> = {},
): WorkspaceSpec {
  return {
    projectSlug: 'proj',
    workspaceId: 's1',
    tool: 'claude',
    mode: 'tui',
    prewarm: false,
    image: 'localhost:5000/img:tag',
    env: ['CALLER_SAID=yes'],
    mounts: [{ source: { kind: 'hostPath', path: '/w' }, mountPath: '/workspace' }],
    resources: {
      memoryRequestBytes: 1, memoryLimitBytes: 2,
      cpuRequestMillis: 3, cpuLimitMillis: 4,
      ephemeralStorageRequestBytes: 5, ephemeralStorageLimitBytes: 6,
    },
    postStartExec: ['/usr/local/bin/yaac-worktree-init'],
    nestedContainers: false,
    substrate,
    ...overrides,
  }
}

interface JobManifest {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        containers: Array<{
          image: string
          env: Array<{ name: string; value: string }>
          lifecycle?: { postStart?: { exec?: { command: string[] } } }
          volumeMounts: Array<{ mountPath: string; readOnly?: boolean }>
        }>
        volumes: Array<{ hostPath?: { path: string; type: string } }>
      }
    }
  }
}

function appliedJob(): JobManifest {
  const call = mockApply.mock.calls.find((c) => (c[0] as { kind?: string }).kind === 'Job')
  expect(call).toBeDefined()
  return call![0] as JobManifest
}

function containerEnv(): Record<string, string> {
  return Object.fromEntries(
    appliedJob().spec.template.spec.containers[0].env.map((e) => [e.name, e.value]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProxyClusterIp.mockResolvedValue('10.96.0.5')
  mockEnsureRunning.mockResolvedValue(undefined)
  mockStoreMount.mockResolvedValue(undefined)
})

/** The registration ConfigMap a prepare applied, decoded. */
function appliedRegistration(): { name: string; labels: Record<string, string>; payload: Record<string, unknown> } | undefined {
  const cm = mockApply.mock.calls
    .map(([m]) => m as { kind: string; metadata: { name: string; labels: Record<string, string> }; data: Record<string, string> })
    .find((m) => m.kind === 'ConfigMap')
  return cm && {
    name: cm.metadata.name,
    labels: cm.metadata.labels,
    payload: JSON.parse(cm.data['registration.json']) as Record<string, unknown>,
  }
}

describe('prepareWorkspaceSubstrate', () => {
  it('rolls the proxy and assembles the registration the launch will write', async () => {
    // A stale proxy rolls inside ensureRunning, so by the time the launch
    // writes the registration the proxy can see the object. The prepare
    // itself writes nothing: a prepare overlaps the image build, and a
    // registration with no Job behind it for that long is what the orphan
    // sweep would collect.
    const substrate = await prepareWorkspaceSubstrate({
      ...INTENT,
      proxySecretRules: { TOKEN: { hosts: ['api.example.com'], header: 'Authorization' } },
    })
    expect(mockEnsureRunning).toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()

    // Written right before the Job, in argv order.
    mockApply.mockImplementation(() => Promise.resolve())
    await launchWorkspace(specOf(substrate))
    expect(mockApply.mock.calls.map(([m]) => (m as { kind: string }).kind)).toEqual(['ConfigMap', 'Job'])
    const reg = appliedRegistration()
    expect(reg?.name).toBe('yaac-proxy-reg-s1')
    expect(reg?.labels).toMatchObject({
      app: 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.worktree-id': 's1', 'yaac.project': 'proj',
    })
    expect(reg?.payload).toMatchObject({
      tool: 'claude',
      projectSlug: 'proj',
      repoUrl: 'https://github.com/example/repo.git',
    })
    // The rules carry a project-scoped ref, never a value: the object is a
    // plain ConfigMap precisely because nothing secret is in it.
    expect(reg?.payload.rules).toEqual([{
      hostPattern: 'api.example.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'Authorization', secretRef: 'proj/TOKEN' }],
    }])
  })

  it('skips the project registry and its image store for a plain workspace', async () => {
    await prepareWorkspaceSubstrate(INTENT)

    expect(mockEnsureProjectRegistry).not.toHaveBeenCalled()
    expect(mockStoreMount).not.toHaveBeenCalled()
  })

  it('gives a nested workspace the project registry and this node\'s image store', async () => {
    mockStoreMount.mockResolvedValue({
      source: { kind: 'hostPath', path: '/var/lib/yaac/store/gen-7' },
      mountPath: '/var/lib/shared-images',
      readOnly: true,
    })

    const substrate = await prepareWorkspaceSubstrate({ ...INTENT, nestedContainers: true })
    await launchWorkspace(specOf(substrate, { nestedContainers: true }))

    expect(mockEnsureProjectRegistry).toHaveBeenCalledWith('proj')
    // The refresh for the NEXT workspace is fired detached — this pod's
    // generation is already pinned by the mount above.
    expect(mockEnsureStore).toHaveBeenCalledWith('proj')
    const mounts = appliedJob().spec.template.spec.containers[0].volumeMounts
    expect(mounts).toContainEqual(
      expect.objectContaining({ mountPath: '/var/lib/shared-images', readOnly: true }),
    )
    // Plain HTTP registry: the in-pod engine needs the drop-in to pull it.
    expect(containerEnv().YAAC_REGISTRY_CONF_B64).toEqual(expect.any(String))
    // And the engine is announced on the POD, not just the Job: the image
    // salvage picks its worktrees out of pod deltas, where the spec env
    // that actually starts the engine (YAAC_NESTED_ENGINE, set by
    // worktree-create) is not in hand.
    const podLabels = appliedJob().spec.template.metadata.labels
    expect(podLabels['yaac.nested']).toBe('true')
  })

})

describe('launchWorkspace', () => {
  it('stamps the identity labels the observers read a workspace back by', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const handle = await launchWorkspace(specOf(substrate))

    const job = appliedJob()
    expect(job.metadata.name).toBe('yaac-proj-s1')
    expect(job.metadata.namespace).toBe('yaac')
    expect(job.metadata.labels).toMatchObject({
      'yaac.project': 'proj',
      'yaac.worktree-id': 's1',
      'yaac.data-dir-hash': 'ddh0123456789abc',
      'yaac.tool': 'claude',
    })
    // Absent for tui, so every pod without it — including every pod
    // predating modes — reads as tui rather than as a broken acp one.
    expect(job.metadata.labels['yaac.mode']).toBeUndefined()
    expect(job.metadata.labels['yaac.prewarmed']).toBeUndefined()
    // Same rule for the engine stamp — absent means "no engine here", which
    // is what keeps the image salvage from probing a workspace that has
    // nothing to salvage.
    expect(job.metadata.labels['yaac.nested']).toBeUndefined()

    // The handle names what was just stamped, without a read-back.
    expect(handle).toMatchObject({
      workspaceId: 's1', projectSlug: 'proj', jobName: 'yaac-proj-s1',
      tool: 'claude', declaredTool: 'claude', mode: 'tui',
      running: false, prewarmed: false, terminating: false,
    })
  })

  it('marks an acp workspace and a prewarmed spare with their own labels', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate, { mode: 'acp', prewarm: true }))

    expect(appliedJob().metadata.labels).toMatchObject({
      'yaac.mode': 'acp',
      'yaac.prewarmed': 'true',
    })
  })

  it('adds the transport token and CA trust the caller could not have named', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate))

    const env = containerEnv()
    // The caller's own env survives alongside the runtime's.
    expect(env.CALLER_SAID).toBe('yes')
    expect(env.YAAC_STREAM_TOKEN).toBe('stream-token')
    expect(env.SSL_CERT_FILE).toBe('/etc/yaac/certs/proxy-ca.pem')
  })

  it('routes an SSH workspace through the tunnel sentinel, with no key in the pod', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate, {
      ssh: { knownHostsFile: '/data/proj/known_hosts' },
    }))

    const env = containerEnv()
    expect(env.GIT_SSH_COMMAND).toContain('--proxy 198.18.0.2:10259')
    expect(env.GIT_SSH_COMMAND).toContain('--proxy-type http')
    expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes')
    // Identity comes from the forwarded agent, never a mounted key.
    expect(env.SSH_AUTH_SOCK).toBe('/ssh-agent/socket')
    expect(env.YAAC_SSH_AGENT_UPSTREAM).toBe('10.96.0.5:10261')
    const mounts = appliedJob().spec.template.spec.containers[0].volumeMounts
    expect(mounts).toContainEqual(
      expect.objectContaining({ mountPath: '/home/yaac/.ssh/yaac/known_hosts', readOnly: true }),
    )
  })

  it('builds the same env twice from one spec, because a retry relaunches it', async () => {
    // The retry loop hands the SAME spec back after a failed attempt. If the
    // injections appended to it, the second pod would carry two of each.
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const spec = specOf(substrate, { ssh: { knownHostsFile: '/data/known_hosts' } })

    await launchWorkspace(spec)
    const first = appliedJob().spec.template.spec.containers[0].env
    mockApply.mockClear()
    await launchWorkspace(spec)
    const second = appliedJob().spec.template.spec.containers[0].env

    expect(second).toEqual(first)
    expect(second.filter((e) => e.name === 'YAAC_STREAM_TOKEN')).toHaveLength(1)
  })

  it('ensures the priority classes before applying the Job that names one', async () => {
    // The apiserver rejects a pod whose class is missing: the Job applies
    // and no pod ever appears.
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate))

    expect(mockEnsurePriorityClasses).toHaveBeenCalled()
    expect(mockEnsurePriorityClasses.mock.invocationCallOrder[0])
      .toBeLessThan(mockApply.mock.invocationCallOrder[0])
  })

  it('passes the caller\'s resources and post-start entry through untouched', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate))

    const container = appliedJob().spec.template.spec.containers[0]
    expect(container.image).toBe('localhost:5000/img:tag')
    expect(container.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-worktree-init'] } },
    })
  })
})
