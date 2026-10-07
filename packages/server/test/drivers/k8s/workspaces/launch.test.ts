import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { PRE_STOP_GRACE_SECONDS, dataDirHash } from '#drivers/k8s/substrate'

vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof streamRelayModule>()),
  podStreamToken: vi.fn().mockResolvedValue('stream-token'),
}))

// Mock the proxy rollout. The registration ConfigMap lands in the fake
// cluster like the Job, so the manifests are built for real and asserted on.
const mockEnsureRunning = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/egress/proxy-client', () => ({
  proxyClient: {
    ensureRunning: mockEnsureRunning,
    getCaTrustEnv: () => ['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem'],
  },
}))

// Mock the cluster barrel, which runs pods of its own.
const mockProxyClusterIp = vi.hoisted(() => vi.fn().mockResolvedValue('10.96.0.5'))
const mockEnsureProjectRegistry = vi.hoisted(() => vi.fn())
const mockNpmCacheUrl = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  proxyServiceClusterIp: mockProxyClusterIp,
  ensureProjectRegistry: mockEnsureProjectRegistry,
  servingNpmCacheUrl: mockNpmCacheUrl,
}))

// Mock the node image store, which runs pods of its own.
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

import type * as streamRelayModule from '#drivers/k8s/substrate/stream-relay'
import type * as clusterModule from '#drivers/k8s/cluster'
import { launchWorkspace, prepareWorkspaceSubstrate,
} from '#drivers/k8s/workspaces/launch'
import type { WorkspaceSpec, WorkspaceSubstrate } from '#drivers/contract'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'
import {
  cachedPackagesDir,
  claudeDir,
  imageStoreDir,
  projectDir,
  secretKeyPath,
  workspaceDir,
} from '@yaac/shared/project-paths'

// Mount sources depend on each path's tier, so paths must be real tier paths.
setDataDir('/data/yaac')
const NODE_ROOT = `/var/lib/yaac/node/${dataDirHash()}`

const PROJECT_ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const INTENT = {
  projectId: PROJECT_ID,
  workspaceId: 's1',
  owner: 'o',
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
    projectId: PROJECT_ID,
    workspaceId: 's1',
    tool: 'claude',
    mode: 'tui',
    prewarm: false,
    image: 'localhost:5000/img:tag',
    env: ['CALLER_SAID=yes'],
    secretEnvKeys: [],
    mounts: [{ source: { kind: 'hostPath', path: workspaceDir(PROJECT_ID, 's1') }, mountPath: '/workspace' }],
    moduleDirs: [],
    resources: {
      memoryRequestBytes: 1, memoryLimitBytes: 2,
      cpuRequestMillis: 3, cpuLimitMillis: 4,
      ephemeralStorageRequestBytes: 5, ephemeralStorageLimitBytes: 6,
    },
    postStartExec: ['/usr/local/bin/yaac-workspace-init'],
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
        terminationGracePeriodSeconds?: number
        initContainers?: Array<{ name: string; command: string[]; volumeMounts: Array<{ mountPath: string }> }>
        containers: Array<{
          image: string
          env: Array<{ name: string; value: string }>
          lifecycle?: { postStart?: { exec?: { command: string[] } }; preStop?: { exec?: { command: string[] } } }
          volumeMounts: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          persistentVolumeClaim?: { claimName: string }
        }>
      }
    }
  }
}

/** The manifests applied, in order. */
const applied = (): Array<{ kind: string }> =>
  fakeCluster.callsOf('apply').map((c) => c.body as unknown as { kind: string })

function appliedJob(): JobManifest {
  const job = applied().find((m) => m.kind === 'Job')
  expect(job).toBeDefined()
  return job as unknown as JobManifest
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
  mockNpmCacheUrl.mockResolvedValue(null)
})

/** The registration ConfigMap a prepare applied, decoded. */
function appliedRegistration(): { name: string; labels: Record<string, string>; payload: Record<string, unknown> } | undefined {
  const cm = applied()
    .map((m) => m as { kind: string; metadata: { name: string; labels: Record<string, string> }; data: Record<string, string> })
    .find((m) => m.kind === 'ConfigMap')
  return cm && {
    name: cm.metadata.name,
    labels: cm.metadata.labels,
    payload: JSON.parse(cm.data['registration.json']) as Record<string, unknown>,
  }
}

describe('prepareWorkspaceSubstrate', () => {
  it('rolls the proxy and assembles the registration the launch will write', async () => {
    // Prepare writes nothing: it overlaps the image build, and a
    // registration without a Job for that long would be swept as orphaned.
    const substrate = await prepareWorkspaceSubstrate({
      ...INTENT,
      proxySecretRules: { TOKEN: { hosts: ['api.example.com'], header: 'Authorization' } },
    })
    expect(mockEnsureRunning).toHaveBeenCalled()
    expect(applied()).toEqual([])

    // Applied right before the Job.
    await launchWorkspace(specOf(substrate))
    expect(applied().map((m) => m.kind)).toEqual(['ConfigMap', 'Job'])
    const reg = appliedRegistration()
    expect(reg?.name).toBe('yaac-proxy-reg-s1')
    expect(reg?.labels).toMatchObject({
      app: 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.workspace-id': 's1', 'yaac.project-id': PROJECT_ID,
    })
    expect(reg?.payload).toMatchObject({
      tool: 'claude',
      projectId: PROJECT_ID,
      repoUrl: 'https://github.com/example/repo.git',
    })
    // Only a reference to the secret, never its value.
    expect(reg?.payload.rules).toEqual([{
      hostPattern: 'api.example.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'Authorization', secretRef: `${PROJECT_ID}/TOKEN` }],
    }])
  })

  it('skips the project registry and its image store for a plain workspace', async () => {
    await prepareWorkspaceSubstrate(INTENT)

    expect(mockEnsureProjectRegistry).not.toHaveBeenCalled()
    expect(mockStoreMount).not.toHaveBeenCalled()
  })

  it('gives a nested workspace the project registry and this node\'s image store', async () => {
    mockStoreMount.mockResolvedValue({
      source: { kind: 'hostPath', path: path.join(imageStoreDir(PROJECT_ID), 'gen-7'), type: 'Directory' },
      mountPath: '/var/lib/shared-images',
      readOnly: true,
    })

    const substrate = await prepareWorkspaceSubstrate({ ...INTENT, nestedContainers: true })
    await launchWorkspace(specOf(substrate, { nestedContainers: true }))

    expect(mockEnsureProjectRegistry).toHaveBeenCalledWith(PROJECT_ID)
    expect(mockStoreMount).toHaveBeenCalledWith(PROJECT_ID)
    // A refresh for the next workspace runs in the background.
    expect(mockEnsureStore).toHaveBeenCalledWith(PROJECT_ID)
    const mounts = appliedJob().spec.template.spec.containers[0].volumeMounts
    const store = mounts.find((m) => m.mountPath === '/var/lib/shared-images')
    expect(store).toMatchObject({ readOnly: true })
    expect(appliedJob().spec.template.spec.volumes.find((v) => v.name === store?.name)?.hostPath)
      .toEqual({ path: `${NODE_ROOT}/shared-images/${PROJECT_ID}/gen-7`, type: 'Directory' })
    // The project registry is plain HTTP, so the engine needs this config.
    expect(Buffer.from(containerEnv().YAAC_REGISTRY_CONF_B64, 'base64').toString())
      .toContain(`location = "yaac-reg-${PROJECT_ID}.yaac.svc.cluster.local:5000"`)
    // Labelled on the pod too: image salvage selects workspaces from pods.
    const podLabels = appliedJob().spec.template.metadata.labels
    expect(podLabels['yaac.nested']).toBe('true')
  })

})

describe('launchWorkspace', () => {
  it('stamps the identity labels the observers read a workspace back by', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const handle = await launchWorkspace(specOf(substrate))

    const job = appliedJob()
    expect(job.metadata.name).toBe('yaac-s1')
    expect(job.metadata.namespace).toBe('yaac')
    expect(job.metadata.labels).toMatchObject({
      'yaac.project-id': PROJECT_ID,
      'yaac.workspace-id': 's1',
      'yaac.data-dir-hash': dataDirHash(),
      'yaac.tool': 'claude',
    })
    // Absent means tui.
    expect(job.metadata.labels['yaac.mode']).toBeUndefined()
    expect(job.metadata.labels['yaac.prewarmed']).toBeUndefined()
    // Absent means no nested engine, so salvage skips the pod.
    expect(job.metadata.labels['yaac.nested']).toBeUndefined()

    expect(handle).toMatchObject({
      workspaceId: 's1', projectId: PROJECT_ID, jobName: 'yaac-s1',
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
    expect(env.CALLER_SAID).toBe('yes')
    expect(env.YAAC_STREAM_TOKEN).toBe('stream-token')
    expect(env.SSL_CERT_FILE).toBe('/etc/yaac/certs/proxy-ca.pem')
  })

  // pnpm 11's SQLite store index cannot be shared between pods, so each pod
  // has its own store on the same volume as `.pnpm`, letting pnpm hardlink.
  it('backs each module dir with its own volume and keeps pnpm\'s store inside the root one', async () => {
    const plain = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(plain, {
      moduleDirs: ['/workspace/node_modules', '/workspace/packages/web/node_modules'],
    }))

    const job = appliedJob().spec.template
    const volumes = job.spec.volumes.map((v) => v.name)
    expect(volumes).toContain('pnpm-modules-0')
    expect(volumes).toContain('pnpm-modules-1')
    const mounts = job.spec.containers[0].volumeMounts
    expect(mounts).toContainEqual({ name: 'pnpm-modules-0', mountPath: '/workspace/node_modules' })
    expect(mounts).toContainEqual({ name: 'pnpm-modules-1', mountPath: '/workspace/packages/web/node_modules' })
    expect(job.metadata).toMatchObject({
      annotations: {
        'dev.gvisor.spec.mount.pnpm-modules-0.type': 'bind',
        'dev.gvisor.spec.mount.pnpm-modules-1.type': 'bind',
      },
    })
    expect(job.spec.initContainers).toBeUndefined()
    // Both spellings: pnpm 10 reads only npm_config_.
    expect(containerEnv()).toMatchObject({
      pnpm_config_store_dir: '/workspace/node_modules/.pnpm-store',
      npm_config_store_dir: '/workspace/node_modules/.pnpm-store',
    })

    // Without a root module dir the store stays off the checkout.
    fakeCluster.calls = []
    await launchWorkspace(specOf(plain, { moduleDirs: ['/workspace/packages/web/node_modules'] }))
    expect(containerEnv()).toMatchObject({
      pnpm_config_store_dir: '/home/yaac/.local/share/pnpm/store',
      npm_config_store_dir: '/home/yaac/.local/share/pnpm/store',
    })
  })

  // Passed to the init script, which writes it below the project's own
  // .npmrc; an env var would override a project's own registry.
  it('admits a workspace to the npm cache per its project, and points it there only while it serves', async () => {
    const url = 'http://yaac-npm-cache.yaac.svc.cluster.local:4873/'
    await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT)))
    expect(containerEnv()).not.toHaveProperty('YAAC_NPM_REGISTRY')

    // Not serving yet: no registry, but the label is set per the project.
    expect(appliedJob().spec.template.metadata.labels['yaac.npm-cache']).toBe('true')

    mockNpmCacheUrl.mockResolvedValue(url)
    fakeCluster.calls = []
    await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT)))
    expect(containerEnv().YAAC_NPM_REGISTRY).toBe(url)
    for (const key of ['pnpm_config_registry', 'npm_config_registry']) {
      expect(containerEnv()).not.toHaveProperty(key)
    }

    // Each keeps the workspace off the cache (no registry, no label):
    //  - the project turned it off;
    //  - the allowlist excludes npmjs (the cache bypasses the proxy);
    //  - a proxied npmjs secret (the cache fetches anonymously).
    for (const intent of [
      { ...INTENT, config: { npmCache: false } },
      { ...INTENT, config: { setAllowedUrls: ['github.com', 'api.anthropic.com'] } },
      {
        ...INTENT,
        proxySecretRules: { NPM_TOKEN: { hosts: ['registry.npmjs.org'], header: 'Authorization' } },
      },
    ]) {
      fakeCluster.calls = []
      await launchWorkspace(specOf(await prepareWorkspaceSubstrate(intent)))
      expect(containerEnv()).not.toHaveProperty('YAAC_NPM_REGISTRY')
      expect(appliedJob().spec.template.metadata.labels).not.toHaveProperty('yaac.npm-cache')
    }
  })

  it('routes an SSH workspace through the tunnel sentinel, with no key in the pod', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate, {
      ssh: { knownHostsFile: path.join(projectDir(PROJECT_ID), 'known_hosts') },
    }))

    const env = containerEnv()
    expect(env.GIT_SSH_COMMAND).toContain('--proxy 198.18.0.2:10259')
    expect(env.GIT_SSH_COMMAND).toContain('--proxy-type http')
    expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes')
    // Keys come from the forwarded agent, never a mounted file.
    expect(env.SSH_AUTH_SOCK).toBe('/ssh-agent/socket')
    expect(env.YAAC_SSH_AGENT_UPSTREAM).toBe('10.96.0.5:10261')
    const mounts = appliedJob().spec.template.spec.containers[0].volumeMounts
    expect(mounts).toContainEqual(
      expect.objectContaining({ mountPath: '/home/yaac/.ssh/yaac/known_hosts', readOnly: true }),
    )
  })

  it('builds the same env twice from one spec, because a retry relaunches it', async () => {
    // Retries reuse the spec, so it must not be mutated.
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const spec = specOf(substrate, { ssh: { knownHostsFile: path.join(projectDir(PROJECT_ID), 'known_hosts') } })

    await launchWorkspace(spec)
    const first = appliedJob().spec.template.spec.containers[0].env
    fakeCluster.calls = []
    await launchWorkspace(spec)
    const second = appliedJob().spec.template.spec.containers[0].env

    expect(second).toEqual(first)
    expect(second.filter((e) => e.name === 'YAAC_STREAM_TOKEN')).toHaveLength(1)
  })

  it('resolves every mount from its tier: global subPaths, node paths, the init container, and no hostPath under the data dir', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate, {
      mounts: [
        { source: { kind: 'hostPath', path: workspaceDir(PROJECT_ID, 's1') }, mountPath: '/workspace' },
        {
          source: { kind: 'hostPath', path: path.join(claudeDir(PROJECT_ID), 'settings.json'), type: 'File' },
          mountPath: '/home/yaac/.claude/settings.json',
        },
        { source: { kind: 'hostPath', path: cachedPackagesDir(PROJECT_ID) }, mountPath: '/home/yaac/.cached-packages' },
        {
          source: { kind: 'hostPath', path: path.join(cachedPackagesDir(PROJECT_ID), 'modules', 's1', 'node_modules') },
          mountPath: '/workspace/node_modules',
        },
        { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' },
      ],
      preStopExec: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'],
    }))

    const pod = appliedJob().spec.template.spec
    const byMount = Object.fromEntries(pod.containers[0].volumeMounts.map((m) => [m.mountPath, m]))
    const volume = (name: string) => pod.volumes.find((v) => v.name === name)
    // GLOBAL: subPaths of the one claim, including a file.
    expect(volume(byMount['/workspace'].name)?.persistentVolumeClaim).toEqual({ claimName: 'yaac-global' })
    expect(byMount['/workspace'].subPath).toBe(`projects/${PROJECT_ID}/workspaces/s1`)
    expect(byMount['/home/yaac/.claude/settings.json'].subPath).toBe(`projects/${PROJECT_ID}/claude/settings.json`)
    // NODE-LOCAL: the pod's own node tree.
    expect(volume(byMount['/home/yaac/.cached-packages'].name)?.hostPath)
      .toEqual({ path: `${NODE_ROOT}/projects/${PROJECT_ID}/.cached-packages`, type: 'DirectoryOrCreate' })
    // No hostPath under the data dir.
    for (const v of pod.volumes) {
      expect(v.hostPath?.path.startsWith('/data/yaac')).not.toBe(true)
    }
    // The init container creates exactly the node-local dirs.
    const [init] = pod.initContainers ?? []
    expect(init?.name).toBe('node-dirs')
    expect(init?.command.slice(-2)).toEqual([
      `/node/projects/${PROJECT_ID}/.cached-packages`,
      `/node/projects/${PROJECT_ID}/.cached-packages/modules/s1/node_modules`,
    ])
    expect(volume('node-root')?.hostPath).toEqual({ path: NODE_ROOT, type: 'DirectoryOrCreate' })
    // A grace period long enough for the preStop hook.
    expect(pod.terminationGracePeriodSeconds).toBe(PRE_STOP_GRACE_SECONDS)
    expect(pod.containers[0].lifecycle?.preStop).toEqual({
      exec: { command: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'] },
    })
  })

  it('rejects a server-local mount before anything is applied', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    fakeCluster.calls = []
    await expect(launchWorkspace(specOf(substrate, {
      mounts: [{ source: { kind: 'hostPath', path: secretKeyPath() }, mountPath: '/x' }],
    }))).rejects.toThrow(/SERVER-LOCAL/)
    expect(applied()).toEqual([])
  })

  it('passes the caller\'s resources and post-start entry through untouched', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate))

    const container = appliedJob().spec.template.spec.containers[0]
    expect(container.image).toBe('localhost:5000/img:tag')
    expect(container.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-workspace-init'] } },
    })
  })
})
