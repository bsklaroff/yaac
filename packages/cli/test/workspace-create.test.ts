import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
}))

const { fsFake } = vi.hoisted(() => ({
  fsFake: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn<(file: string, data: string) => Promise<void>>().mockResolvedValue(undefined),
    readFile: vi.fn<(file: string) => Promise<Buffer>>().mockRejectedValue(new Error('missing')),
    chmod: vi.fn().mockResolvedValue(undefined),
    // An empty readdir means no built-in skills are staged.
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    cp: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    // Implementations passed to `vi.fn(...)` survive `resetAllMocks`;
    // `.mockResolvedValue()` ones do not.
    rename: vi.fn(() => Promise.resolve()),
    // No `.git` file, so no checkout needs converting on resume.
    lstat: vi.fn((_p: string): Promise<{ isDirectory: () => boolean }> => Promise.reject(new Error('missing'))),
  },
}))

// Agent history moves real files and is not what this file tests.
vi.mock('@yaac/server/domain/agent-history', async (importOriginal) => ({
  ...await importOriginal<object>(),
  convergeAgentHistory: vi.fn(() => Promise.resolve()),
}))
vi.mock('node:fs/promises', () => ({ default: fsFake }))

// Confined roots use realpath and fds, which the fs mock lacks, so route
// them through that mock instead.
vi.mock('@yaac/server/lib/confined-fs', () => ({
  openRoot: vi.fn((root: string) => Promise.resolve({
    mkdirp: () => Promise.resolve(),
    readFile: (rel: string) => fsFake.readFile(`${root}/${rel}`).catch(() => null),
    writeAtomic: (rel: string, data: string) => fsFake.writeFile(`${root}/${rel}`, data),
    locked: <T>(_rel: string, task: () => Promise<T>) => task(),
  })),
}))

// Keeps podman off the import path; create never calls it.
vi.mock('@yaac/server/drivers/k8s/image-engine/image-builder', () => ({
} satisfies Partial<typeof imageBuilderModule>))

vi.mock('@yaac/server/drivers/k8s/images/build-coordinator', () => ({
  ensureImage: vi.fn().mockResolvedValue('yaac-test-image'),
} satisfies Partial<typeof buildCoordinatorModule>))

vi.mock('@yaac/server/drivers/k8s/substrate/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  ensureKubernetes: vi.fn().mockResolvedValue(undefined),
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
} satisfies Partial<typeof kubectlModule>))

// proxyServiceClusterIp would otherwise hit the pod-shaped kubectlGetJson
// mock and throw. The pod uses this IP as its DNS nameserver.
vi.mock('@yaac/server/drivers/k8s/cluster/proxy-apply', async (importOriginal) => ({
  ...(await importOriginal()),
  proxyServiceClusterIp: vi.fn().mockResolvedValue('10.96.0.5'),
}))

vi.mock('@yaac/server/drivers/k8s/substrate/exec', () => ({
  containerExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
} satisfies Partial<typeof execModule>))

vi.mock('#commands/ws-terminal', () => ({
  attachWorkspacePty: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/server/drivers/k8s/egress/proxy-client', () => ({
  proxyClient: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    getCaTrustEnv: vi.fn().mockReturnValue(['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem']),
  },
  // No `satisfies Partial<…>`: a 2-method subset of the `ProxyClient` class
  // fails that check.
}))

vi.mock('@yaac/server/lib/allowed-hosts', async (importOriginal) => {
  const actual = await importOriginal<typeof allowedHostsModule>()
  return {
    ...actual,
    // '*' passes create's allowlist check; tests override as needed.
    resolveAllowedHosts: vi.fn().mockReturnValue(['*']),
  }
})

// Spread the real module so `instanceof RelayDialError` checks still work.
vi.mock('@yaac/server/drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof streamRelayModule>(),
  bootStreamd: vi.fn().mockResolvedValue(undefined),
  podStreamToken: vi.fn().mockResolvedValue('stream-token'),
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  waitForStreamd: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/server/drivers/k8s/substrate/pod-wait', () => ({
  waitForJobPodReady: vi.fn().mockResolvedValue(undefined),
}))

// Bypassed so the tests assert on the declared mounts. Resolution is
// covered in substrate/mount-sources.test.ts.
vi.mock('@yaac/server/drivers/k8s/substrate/mount-sources', () => ({
  resolveMountSource: (m: unknown) => m,
  nodeLocalDirsOf: () => [],
  nodeLocalHostPath: (p: string) => p,
  nodeLocalNodePath: () => '/var/lib/yaac/node/ddh0123456789abc',
}))

// Replaced wholesale so every path lands under /tmp and never a real data
// dir. A helper the create path starts using must be added here by hand.
vi.mock('@yaac/shared/project-paths', () => ({
  // Read at module scope by a module in this import graph.
  CALICO_DIR: '/tmp/yaac-package/k8s/calico',
  repoDir: vi.fn((slug: string) => `/tmp/${slug}/repo`),
  agentHistoryDir: vi.fn((slug: string, workspaceId: string, part?: string) =>
    `/tmp/${slug}/history/${workspaceId}${part !== undefined ? `/${part}` : ''}`),
  AGENT_HISTORY_PARTS: ['claude', 'claude-file-history', 'codex', 'codex-sqlite', 'pi'],
  claudeDir: vi.fn((slug: string) => `/tmp/${slug}/claude`),
  codexDir: vi.fn((slug: string) => `/tmp/${slug}/codex`),
  opencodeConfigDir: vi.fn((slug: string) => `/tmp/${slug}/opencode-config`),
  opencodeDataDir: vi.fn((slug: string, workspaceId: string) => `/tmp/node/${slug}/opencode-data/${workspaceId}`),
  opencodeCheckpointDir: vi.fn((slug: string, workspaceId: string) => `/tmp/${slug}/opencode-data/${workspaceId}`),
  piDir: vi.fn((slug: string) => `/tmp/${slug}/pi`),
  cachedPackagesDir: vi.fn((slug: string) => `/tmp/${slug}/.cached-packages`),
  acpLogDir: vi.fn((slug: string, workspaceId: string) => `/tmp/${slug}/acp/${workspaceId}`),
  workspaceAttachmentsDir: vi.fn((slug: string, workspaceId: string) => `/tmp/${slug}/attachments/${workspaceId}`),
  cacheVolumeDir: vi.fn((slug: string, key: string) => `/tmp/${slug}/cache-volumes/${key}`),
  workspaceDir: vi.fn((slug: string, workspaceId: string) => `/tmp/${slug}/workspaces/${workspaceId}`),
  workspacesDir: vi.fn((slug: string) => `/tmp/${slug}/workspaces`),
  projectDir: vi.fn((slug: string) => `/tmp/${slug}`),
  workspaceStateDir: vi.fn((slug: string, sid: string) => `/tmp/${slug}/sessions/${sid}`),
  credentialsDir: vi.fn(() => '/tmp/yaac-data/.credentials'),
  getDataDir: vi.fn(() => '/tmp/yaac-data'),
  PACKAGE_ROOT: '/tmp/yaac-package',
}))

const { projectRow } = vi.hoisted(() => ({
  projectRow: (remoteUrl: string) => ({
    slug: 'demo',
    id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
    remoteUrl,
    addedAt: '2026-01-01T00:00:00.000Z',
    createDefaults: {},
    gitCredentialId: null,
    knownHostsEntry: null,
  }),
}))
vi.mock('@yaac/server/db/project-store', async (importOriginal) => ({
  ...await importOriginal<typeof projectStoreModule>(),
  getProjectRow: vi.fn().mockResolvedValue(projectRow('https://github.com/example/repo.git')),
} satisfies Partial<typeof projectStoreModule>))

vi.mock('@yaac/server/domain/projects/config', () => ({
  resolveProjectConfig: vi.fn().mockResolvedValue({}),
  resolveEphemeralModulesPaths: () => [],
} satisfies Partial<typeof projectConfigModule>))

vi.mock('@yaac/server/domain/projects/env', () => ({
  resolveProjectEnv: vi.fn().mockResolvedValue({ plain: {}, secrets: {} }),
}))

vi.mock('@yaac/server/domain/projects/credentials', () => ({
  resolveProjectCredential: vi.fn().mockResolvedValue({ kind: 'https', token: 'token' }),
  missingCredentialError: (slug: string) => new Error(`no credential for ${slug}`) as never,
  parseGitRemote: (url: string) => {
    if (url.startsWith('https://')) {
      const u = new URL(url)
      const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '')
      return { scheme: 'https', host: u.hostname, path }
    }
    const m = /^(?:[\w._-]+@)?([\w.-]+):(.+)$/.exec(url)!
    const path = m[2].replace(/\.git$/, '')
    return { scheme: 'ssh', host: m[1], path }
  },
} satisfies Partial<typeof credentialsModule>))

vi.mock('@yaac/shared/tool-auth', () => ({
  loadToolAuthEntry: vi.fn().mockResolvedValue(null),
  loadClaudeCredentialsFile: vi.fn().mockResolvedValue(null),
  loadCodexCredentialsFile: vi.fn().mockResolvedValue(null),
  writeProjectClaudePlaceholder: vi.fn().mockResolvedValue(undefined),
  writeProjectCodexPlaceholder: vi.fn().mockResolvedValue(undefined),
  PLACEHOLDER_API_KEY: 'test-placeholder-key',
  PLACEHOLDER_GH_TOKEN: 'test-placeholder-gh-token',
}))

vi.mock('@yaac/server/domain/git', () => ({
  createCheckout: vi.fn().mockResolvedValue(undefined),
  // Inline so it survives resetAllMocks.
  maintainRepo: vi.fn(() => Promise.resolve()),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  remoteBranchExists: vi.fn().mockResolvedValue(true),
  writeKnownHostsFile: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof gitModule>))

// Left real: declaring a forward is in-memory bookkeeping.
vi.mock('@yaac/server/drivers/k8s/forwarders/port-forwarders', async (importOriginal) => ({
  ...await importOriginal<typeof portForwardersModule>(),
} satisfies Partial<typeof portForwardersModule>))

vi.mock('@yaac/server/lib/status-right', async (importOriginal) => ({
  ...await importOriginal<typeof statusRightModule>(),
  buildStatusRight: vi.fn().mockReturnValue(' stub-status '),
}))

vi.mock('@yaac/server/db/workspace-store', () => ({
  recordWorkspaceCreated: vi.fn(),
  recordWorkspaceResumed: vi.fn(),
  recordWorkspaceLife: vi.fn(),
  recordWorkspaceStopped: vi.fn(),
  deleteWorkspaceRow: vi.fn(),
  setWorkspaceBaseBranch: vi.fn(),
  getWorkspaceRow: vi.fn(),
  listProjectWorkspaceIds: vi.fn(() => Promise.resolve(new Map<string, boolean>())),
} satisfies Partial<typeof storeModule>))

vi.mock('@yaac/server/db/preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof preferencesModule>()),
  getGitIdentity: vi.fn(),
}))

vi.mock('@yaac/server/db/agent-session-store', () => ({
  recordAgentSessions: vi.fn(),
  setActiveAgentSessions: vi.fn(),
  deleteWorkspaceAgentSessions: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof agentStoreModule>))

// Without `deleteWorkspaceState`, a failed fresh create's rollback would
// fail silently and leave the row, rather than failing the test.
vi.mock('@yaac/server/domain/workspaces/cleanup', () => ({
  cleanupWorkspaceDetached: vi.fn(),
  // Inline so it survives resetAllMocks (see the fs mock above).
  deleteWorkspaceState: vi.fn(() => Promise.resolve(true)),
} satisfies Partial<typeof cleanupModule>))

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWorkspace } from '@yaac/server/domain/workspaces/create'
import {
  deleteWorkspaceRow,
  getWorkspaceRow,
  recordWorkspaceCreated,
  recordWorkspaceStopped,
} from '@yaac/server/db/workspace-store'
import { recordAgentSessions } from '@yaac/server/db/agent-session-store'
import { buildAgentCmd, resolveInitWindows } from '@yaac/server/runtime/agents/agent-command'
import { retoolSpare } from '@yaac/server/domain/workspaces/spare-pool'
import { workspaceCreate } from '#commands/workspace-create'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { ensureKubernetes } from '@yaac/server/drivers/k8s/substrate/kubectl'
import { ensureImage } from '@yaac/server/drivers/k8s/images/build-coordinator'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@yaac/server/drivers/k8s/substrate/kubectl'
import { containerExec } from '@yaac/server/drivers/k8s/substrate/exec'
import { proxyServiceClusterIp } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { proxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { resolveProjectConfig } from '@yaac/server/domain/projects/config'
import { resolveProjectEnv } from '@yaac/server/domain/projects/env'
import { getGitIdentity } from '@yaac/server/db/preferences'
import { resolveProjectCredential } from '@yaac/server/domain/projects/credentials'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import { CONTAINER_TMUX_DIR } from '@yaac/shared/paths'
import { resolveAllowedHosts } from '@yaac/server/lib/allowed-hosts'
import { createCheckout, getDefaultBranch, fetchOrigin, remoteBranchExists } from '@yaac/server/domain/git'
import { getProjectRow } from '@yaac/server/db/project-store'
import { podExec, waitForStreamd } from '@yaac/server/drivers/k8s/substrate/stream-relay'
import type * as streamRelayModule from '@yaac/server/drivers/k8s/substrate/stream-relay'
import { waitForJobPodReady } from '@yaac/server/drivers/k8s/substrate/pod-wait'
import {
  declareWorkspaceForwards,
  getWorkspacePorts,
  stopAllWorkspaceForwarders,
} from '@yaac/server/drivers/k8s/forwarders/port-forwarders'
import { buildStatusRight } from '@yaac/server/lib/status-right'
import type * as statusRightModule from '@yaac/server/lib/status-right'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { launchWorkspace, prepareWorkspaceSubstrate } from '@yaac/server/drivers/k8s/workspaces/launch'
import { destroyWorkspace } from '@yaac/server/drivers/k8s/workspaces/teardown'
import { prepareWorkspaceImage } from '@yaac/server/drivers/k8s/images/workspace-image'

const mockSpawn = vi.mocked(spawn)
const mockAccess = vi.mocked(fs.access)
const mockMkdir = vi.mocked(fs.mkdir)
const mockWriteFile = vi.mocked(fs.writeFile)
const mockReadFile = vi.mocked(fs.readFile)
const mockReaddir = vi.mocked(fs.readdir)
const mockApply = vi.mocked(kubectlApply)

/** Applied Job manifests only (create also applies PriorityClasses). */
function jobApplies(): unknown[] {
  return mockApply.mock.calls
    .map((c) => c[0] as { kind?: string })
    .filter((m) => m.kind === 'Job')
}
const mockGetJson = vi.mocked(kubectlGetJson)
const mockKubectlRetry = vi.mocked(kubectlWithRetry)
const mockContainerExec = vi.mocked(containerExec)
const mockPodExec = vi.mocked(podExec)
const mockWaitForStreamd = vi.mocked(waitForStreamd)
const mockWaitForPodReady = vi.mocked(waitForJobPodReady)
const mockLoadToolAuth = vi.mocked(loadToolAuthEntry)

function mockAttachedChild(): EventEmitter {
  const child = new EventEmitter()
  process.nextTick(() => child.emit('close', 0))
  return child
}

interface JobManifest {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    backoffLimit: number
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        restartPolicy: string
        dnsPolicy?: string
        dnsConfig?: { nameservers: string[] }
        initContainers?: Array<{
          name: string
          image: string
          restartPolicy?: string
          env: Array<{ name: string; value: string }>
        }>
        containers: Array<{
          image: string
          env: Array<{ name: string; value: string }>
          lifecycle?: { postStart?: { exec?: { command: string[] } }; preStop?: { exec?: { command: string[] } } }
          volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
          emptyDir?: { sizeLimit?: string }
        }>
      }
    }
  }
}

function appliedJobManifest(): JobManifest {
  const call = mockApply.mock.calls.find((c) => (c[0] as { kind?: string }).kind === 'Job')
  expect(call).toBeDefined()
  return call![0] as JobManifest
}

describe('createWorkspace', () => {
  beforeEach(() => {
    vi.resetAllMocks()

    // Store reads must return promises: createWorkspace `.catch()`es them.
    vi.mocked(getWorkspaceRow).mockResolvedValue(undefined)
    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockReadFile.mockRejectedValue(new Error('missing'))
    // No built-in skills, but workspace-bin must contain yaac-workspace-init
    // or createWorkspace refuses to provision.
    mockReaddir.mockImplementation(((dir: string) => Promise.resolve(
      dir === '/tmp/yaac-package/workspace-bin'
        ? [{ name: 'yaac-workspace-init', isFile: () => true }]
        : [],
    )) as never)
    vi.mocked(ensureKubernetes).mockResolvedValue(undefined)
    vi.mocked(ensureImage).mockResolvedValue('yaac-test-image')
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(resolveProjectCredential).mockResolvedValue({ kind: 'https', token: 'token' } as never)
    vi.mocked(resolveAllowedHosts).mockReturnValue(['*'])
    vi.mocked(createCheckout).mockResolvedValue(undefined)
    vi.mocked(getDefaultBranch).mockResolvedValue('main')
    vi.mocked(fetchOrigin).mockResolvedValue(undefined)
    vi.mocked(getProjectRow).mockResolvedValue(projectRow('https://github.com/example/repo.git'))
    vi.mocked(remoteBranchExists).mockResolvedValue(true)
    vi.mocked(resolveProjectEnv).mockResolvedValue({ plain: {}, secrets: {} })
    vi.mocked(getGitIdentity).mockResolvedValue({ name: 'Test User', email: 'test@example.com' })
    mockLoadToolAuth.mockResolvedValue(null)
    vi.mocked(proxyServiceClusterIp).mockResolvedValue('10.96.0.5')
    /* eslint-disable @typescript-eslint/unbound-method */
    vi.mocked(proxyClient.ensureRunning).mockResolvedValue(undefined)
    vi.mocked(proxyClient.getCaTrustEnv).mockReturnValue(['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem'])
    /* eslint-enable @typescript-eslint/unbound-method */
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockApply.mockResolvedValue(undefined)
    mockGetJson.mockResolvedValue(null)
    // Healthy by default; failure tests override waitForJobPodReady.
    mockWaitForPodReady.mockResolvedValue(undefined)
    mockWaitForStreamd.mockResolvedValue(undefined)
    mockKubectlRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockPodExec.mockResolvedValue({ stdout: '', stderr: '' })
    vi.mocked(buildStatusRight).mockReturnValue(' stub-status ')
    // The forward registry is process-wide; reset it so host ports don't
    // carry over between cases.
    stopAllWorkspaceForwarders()

    // Wire the real k8s implementations for the verbs a launch uses; the
    // rest keep the fake's defaults, so a new driver dependency fails the
    // test instead of silently calling a cluster. kubectl, the proxy client,
    // the relay and podman stay mocked.
    installFakeWorkspaceDriver({
      ensureRuntimeReachable: () => ensureKubernetes(),
      prepareImage: (o) => prepareWorkspaceImage(o),
      prepareSubstrate: (i) => prepareWorkspaceSubstrate(i),
      launch: (spec) => launchWorkspace(spec),
      awaitReady: (h) => waitForJobPodReady(h.jobName),
      awaitAgentTransport: (j, o) => waitForStreamd(j, o),
      exec: (j, c, o) => podExec(j, c, o),
      declareForwards: (id, forwards) => declareWorkspaceForwards(id, forwards),
      destroy: (t, o) => destroyWorkspace(t, o),
    })
  })


  it('creates the workspace from an explicitly requested branch, borrowing from the main clone', async () => {
    const result = await createWorkspace('demo', { tool: 'claude', branch: 'dev' })
    expect(vi.mocked(createCheckout)).toHaveBeenCalledWith(
      '/tmp/demo/repo',
      `/tmp/demo/workspaces/${result?.workspaceId}`,
      { branch: `agent/${result?.workspaceId}`, baseBranch: 'dev', remoteUrl: 'https://github.com/example/repo.git' },
    )
    // The launch points the clone at the main clone as the server sees it.
    const linkCall = mockPodExec.mock.calls.find(([, cmd]) => cmd.includes('objects/info/alternates'))
    expect(linkCall?.[1]).toContain("'/tmp/demo/repo/.git/objects'")
  })

  it('records the workspace and its first conversation before the Job', async () => {
    const result = await createWorkspace('demo', {
      tool: 'codex', branch: 'dev', initialPrompt: 'ship it', model: 'gpt-6-sol',
    })
    expect(vi.mocked(recordWorkspaceCreated)).toHaveBeenCalledWith({
      projectSlug: 'demo',
      workspaceId: result?.workspaceId,
      // Stored so a restart relaunches with the user's choice and a spare
      // claim can match on it. `bypass` because the fake driver is sandboxed.
      permissionMode: 'bypass',
      mode: 'tui',
      model: 'gpt-6-sol',
      // Stored up front: a workspace queued while this one boots defaults
      // to it.
      baseBranch: 'dev',
    })
    // The tool, first prompt and model are stored on the first conversation.
    expect(vi.mocked(recordAgentSessions)).toHaveBeenCalledWith(
      'demo',
      result?.workspaceId,
      [{
        tool: 'codex', agentSessionId: result?.workspaceId, mode: 'tui', firstPrompt: 'ship it', model: 'gpt-6-sol',
      }],
    )
    // No pod may exist without a row.
    const recordOrder = vi.mocked(recordWorkspaceCreated).mock.invocationCallOrder[0] ?? Infinity
    const jobApplyIdx = mockApply.mock.calls
      .findIndex((c) => (c[0] as { kind?: string }).kind === 'Job')
    const applyOrder = mockApply.mock.invocationCallOrder[jobApplyIdx] ?? 0
    expect(recordOrder).toBeLessThan(applyOrder)
  })

  it('fails the create before provisioning anything when the row cannot be written', async () => {
    vi.mocked(recordWorkspaceCreated).mockRejectedValueOnce(new Error('disk full'))
    await expect(createWorkspace('demo', { tool: 'claude' })).rejects.toThrow('disk full')
    expect(jobApplies()).toHaveLength(0)
  })

  it('rolls the row back when a fresh create gives up', async () => {
    mockWaitForPodReady.mockRejectedValue(new Error('pod never became ready'))
    await expect(createWorkspace('demo', { tool: 'claude' })).rejects.toThrow()
    // The rollback is not awaited, so it lands after the rejection.
    await vi.waitFor(() => {
      expect(vi.mocked(deleteWorkspaceRow)).toHaveBeenCalledWith('demo', expect.any(String))
    })
  })

  it('keeps a failed restart\'s row instead of erasing its history', async () => {
    // The row holds the title, pin and prompt, and still carries its stop.
    mockWaitForPodReady.mockRejectedValue(new Error('pod never became ready'))
    await expect(
      createWorkspace('demo', { tool: 'claude', resume: true, workspaceId: 'prior-session' }),
    ).rejects.toThrow()
    expect(vi.mocked(deleteWorkspaceRow)).not.toHaveBeenCalled()
    expect(vi.mocked(recordWorkspaceStopped)).not.toHaveBeenCalled()
  })

  it('flags a prewarmed spare — a spare is not a workspace until claimed', async () => {
    // A spare still gets a row, so a reaped spare can be told apart from a
    // stopped workspace. The flag hides it from listings until claimed, and
    // the claim records the conversation.
    await createWorkspace('demo', { tool: 'claude', prewarm: true })

    expect(vi.mocked(recordWorkspaceCreated)).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: 'demo', spare: true }),
    )
    expect(vi.mocked(recordAgentSessions)).not.toHaveBeenCalled()
  })

  it('creates from the requested branch without asking origin for its default', async () => {
    await createWorkspace('demo', { tool: 'claude', branch: 'dev' })
    expect(vi.mocked(createCheckout)).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ baseBranch: 'dev' }),
    )
    expect(vi.mocked(getDefaultBranch)).not.toHaveBeenCalled()
  })

  it('rejects a requested branch missing from origin', async () => {
    vi.mocked(remoteBranchExists).mockResolvedValue(false)
    await expect(createWorkspace('demo', { tool: 'claude', branch: 'ghost' }))
      .rejects.toThrow(/branch "ghost" not found on origin/)
    expect(vi.mocked(createCheckout)).not.toHaveBeenCalled()
  })

  it('a bad branch fails fast: one Job apply, one delete, no recreate retries', async () => {
    // A bad input (SetupInputError) must skip the Job-recreate retries.
    vi.mocked(remoteBranchExists).mockResolvedValue(false)
    await expect(createWorkspace('demo', { tool: 'claude', branch: 'ghost', workspaceId: 'abcd1234' }))
      .rejects.toThrow(/branch "ghost" not found/)

    expect(jobApplies()).toHaveLength(1)
    const deleteCalls = mockKubectlRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'job')
    expect(deleteCalls).toHaveLength(1)
  })

  it('returns a session descriptor with the job name, without attaching', async () => {
    const result = await createWorkspace('demo', { tool: 'codex' })

    expect(result).toBeDefined()
    expect(result?.workspaceId).toEqual(expect.any(String))
    expect(result?.jobName).toBe(`yaac-demo-${result?.workspaceId}`)
    expect(result?.tool).toBe('codex')
    expect(result?.forwardedPorts).toEqual([])
    expect(jobApplies()).toHaveLength(1)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('seeds OPENROUTER_API_KEY when the opencode credential uses the openrouter provider', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'opencode' ? {
      tool: 'opencode',
      kind: 'api-key',
      apiKey: 'sk-or-real',
      savedAt: new Date().toISOString(),
      opencodeProvider: 'openrouter',
    } : null))
    await createWorkspace('demo', { tool: 'opencode', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'OPENROUTER_API_KEY', value: 'test-placeholder-key' })
    expect(env.map((e) => e.name)).not.toContain('NEURALWATT_API_KEY')
  })

  it('seeds NEURALWATT_API_KEY when the opencode credential uses the neuralwatt provider', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'opencode' ? {
      tool: 'opencode',
      kind: 'api-key',
      apiKey: 'nw-real',
      savedAt: new Date().toISOString(),
      opencodeProvider: 'neuralwatt',
    } : null))
    await createWorkspace('demo', { tool: 'opencode', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'NEURALWATT_API_KEY', value: 'test-placeholder-key' })
    expect(env.map((e) => e.name)).not.toContain('OPENROUTER_API_KEY')
  })

  it('seeds ANTHROPIC_API_KEY + the pi session dir when the pi credential uses anthropic', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'pi' ? {
      tool: 'pi',
      kind: 'api-key',
      apiKey: 'sk-ant-real',
      savedAt: new Date().toISOString(),
      piProvider: 'anthropic',
    } : null))
    await createWorkspace('demo', { tool: 'pi', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' })
    // Set for every pi session.
    expect(env).toContainEqual({ name: 'PI_CODING_AGENT_SESSION_DIR', value: '/home/yaac/.yaac-pi-sessions' })
    expect(env).toContainEqual({ name: 'PI_SKIP_VERSION_CHECK', value: '1' })
  })

  it('seeds OPENAI_API_KEY when the pi credential uses the openai provider', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'pi' ? {
      tool: 'pi',
      kind: 'api-key',
      apiKey: 'sk-oai-real',
      savedAt: new Date().toISOString(),
      piProvider: 'openai',
    } : null))
    await createWorkspace('demo', { tool: 'pi', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'OPENAI_API_KEY', value: 'test-placeholder-key' })
  })

  it('seeds every credentialed tool\'s placeholder env on any session (spares are retoolable)', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'codex' ? null : {
      tool,
      kind: 'api-key',
      apiKey: 'real-key',
      savedAt: new Date().toISOString(),
      ...(tool === 'opencode' ? { opencodeProvider: 'openrouter' } : {}),
    } as never))
    await createWorkspace('demo', { tool: 'codex', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' })
    expect(env).toContainEqual({ name: 'OPENROUTER_API_KEY', value: 'test-placeholder-key' })
    expect(env).toContainEqual({ name: 'OPENCODE_DISABLE_AUTOUPDATE', value: '1' })
    // Codex has no credential here, and under codex OAuth this var would
    // switch it into api-key mode.
    expect(env.map((e) => e.name)).not.toContain('OPENAI_API_KEY')
  })

  it('seeds OPENAI_API_KEY only for a codex api-key credential, never for codex OAuth', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'codex' ? {
      tool: 'codex',
      kind: 'oauth',
      apiKey: 'access-token',
      savedAt: new Date().toISOString(),
    } as never : null))
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })
    expect(appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name))
      .not.toContain('OPENAI_API_KEY')

    mockApply.mockClear()
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'codex' ? {
      tool: 'codex',
      kind: 'api-key',
      apiKey: 'sk-real',
      savedAt: new Date().toISOString(),
    } as never : null))
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1235' })
    expect(appliedJobManifest().spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'OPENAI_API_KEY', value: 'test-placeholder-key' })
  })

  it('applies a Job manifest with session labels, the registry image ref, and shared mounts', async () => {
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const manifest = appliedJobManifest()
    expect(manifest.metadata.name).toBe('yaac-demo-abcd1234')
    expect(manifest.metadata.namespace).toBe('yaac')

    const labels = {
      'yaac.project': 'demo',
      'yaac.project-id': projectRow('').id,
      'yaac.workspace-id': 'abcd1234',
      'yaac.data-dir-hash': 'ddh0123456789abc',
      'yaac.tool': 'claude',
      // npmCache defaults on and npmjs is allowed, so the pod is admitted.
      'yaac.npm-cache': 'true',
    }
    expect(manifest.metadata.labels).toEqual(labels)
    expect(manifest.spec.template.metadata.labels).toEqual(labels)
    expect(manifest.spec.backoffLimit).toBe(0)
    expect(manifest.spec.template.spec.restartPolicy).toBe('Never')

    const container = manifest.spec.template.spec.containers[0]
    expect(container.image).toBe('yaac-registry.yaac.svc.cluster.local:5000/yaac-test-image')
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'YAAC_WORKSPACE_ID', value: 'abcd1234' },
      { name: 'SSL_CERT_FILE', value: '/etc/yaac/certs/proxy-ca.pem' },
    ]))
    // Egress interception is transparent, so no proxy env vars.
    const envNames = container.env.map((e) => e.name)
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      expect(envNames).not.toContain(name)
    }

    const hostPaths = manifest.spec.template.spec.volumes
      .filter((v) => v.hostPath)
      .map((v) => v.hostPath!.path)
    expect(hostPaths).toEqual(expect.arrayContaining([
      '/tmp/demo/workspaces/abcd1234',
      '/tmp/demo/repo/.git',
      '/tmp/demo/claude',
      '/tmp/demo/codex',
      `/tmp/node/${projectRow('').id}/opencode-data/abcd1234`,
      '/tmp/demo/opencode-data/abcd1234',
      '/tmp/demo/opencode-config',
      '/tmp/demo/pi',
    ]))
    // A package tree shared by every pod would be a channel between them.
    expect(hostPaths).not.toContain('/tmp/demo/.cached-packages')
    // With CLAUDE_CONFIG_DIR set, claude's global config lives inside the
    // claude home mount.
    expect(hostPaths).not.toContain('/tmp/demo/claude.json')

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/claude', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/codex', { recursive: true })
  })

  it('puts the tmux socket dir on a pod-local emptyDir, with no host dir behind it', async () => {
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const { volumes, containers } = appliedJobManifest().spec.template.spec
    const mount = containers[0].volumeMounts.find((m) => m.mountPath === CONTAINER_TMUX_DIR)
    expect(mount).toBeDefined()
    const volume = volumes.find((v) => v.name === mount!.name)
    // Everything reaches tmux by exec into this pod, so the socket needs no
    // host dir.
    expect(volume).toEqual({ name: mount!.name, emptyDir: {} })
    expect(volumes.some((v) => v.hostPath?.path.endsWith('/tmux'))).toBe(false)
    expect(mockMkdir).not.toHaveBeenCalledWith(
      expect.stringContaining('/tmux'),
      expect.anything(),
    )
  })

  it('injects no per-pod egress sidecars and points the pod resolver at the proxy', async () => {
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const spec = appliedJobManifest().spec.template.spec
    // netd redirects egress at the node, so no init containers.
    expect(spec.initContainers).toBeUndefined()
    // DNS goes to the proxy Service's ClusterIP. The proxy identifies pods
    // by source IP, so no token is needed.
    expect(spec.dnsPolicy).toBe('None')
    expect(proxyServiceClusterIp).toHaveBeenCalled()
    expect(spec.dnsConfig).toEqual({ nameservers: ['10.96.0.5'] })
    const sessionEnvNames = spec.containers[0].env.map((e: { name: string }) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
    expect(proxyClient).not.toHaveProperty('relayToken')
  })

  it('routes SSH through the redirected tunnel sentinel with no credential', async () => {
    // ncat CONNECTs to a sentinel address that netd redirects to the proxy's
    // tunnel listener. The proxy identifies the pod by source IP, so no
    // credential is in the pod env.
    vi.mocked(getProjectRow).mockResolvedValue(projectRow('git@github.com:example/repo.git'))
    vi.mocked(resolveProjectCredential).mockResolvedValue({
      kind: 'ssh', id: 'k', publicKey: 'ssh-ed25519 AAAA yaac k', knownHostsEntry: 'github.com ssh-ed25519 AAAAC3',
    })

    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    const sshCmd = env.find((e) => e.name === 'GIT_SSH_COMMAND')?.value ?? ''
    expect(sshCmd).toContain('ncat --proxy 198.18.0.2:10259')
    expect(sshCmd).toContain('--proxy-type http')
    expect(sshCmd).not.toContain('--proxy-auth')
    expect(sshCmd).not.toContain('x:')
    expect(sshCmd).not.toContain('abcd1234')
  })

  it('adds the placeholder API key env for claude api-key auth', async () => {
    mockLoadToolAuth.mockImplementation((tool) =>
      Promise.resolve(tool === 'claude' ? { kind: 'api-key' } as never : null))

    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' },
    ]))
  })

  it('seeds a placeholder GH_TOKEN for an HTTPS github.com remote', async () => {
    await createWorkspace('demo', { workspaceId: 'abcd1234' })

    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'GH_TOKEN', value: 'test-placeholder-gh-token' },
    ]))
  })

  it('does not seed GH_TOKEN for a non-GitHub HTTPS remote', async () => {
    vi.mocked(getProjectRow).mockResolvedValue(projectRow('https://gitlab.com/example/repo.git'))

    await createWorkspace('demo', { workspaceId: 'abcd1234' })

    const envNames = appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name)
    expect(envNames).not.toContain('GH_TOKEN')
  })

  it('does not override a GH_TOKEN the project sets itself', async () => {
    vi.mocked(resolveProjectEnv).mockResolvedValue({
      plain: { GH_TOKEN: 'ghp_user' },
      secrets: {},
    })

    await createWorkspace('demo', { workspaceId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env.find((e) => e.name === 'GH_TOKEN')?.value).toBe('ghp_user')
  })

  it('defers to a proxied GITHUB_TOKEN secret instead of auto-wiring gh', async () => {
    vi.mocked(resolveProjectEnv).mockResolvedValue({
      plain: {},
      secrets: {
        GITHUB_TOKEN: { value: 'sekrit', rule: { hosts: ['api.github.com'] } },
      },
    })

    await createWorkspace('demo', { workspaceId: 'abcd1234' })

    const envNames = appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name)
    expect(envNames).not.toContain('GH_TOKEN')
  })

  it('never chowns mounts in-container — uid alignment makes server dirs writable', async () => {
    await createWorkspace('demo', { workspaceId: 'abcd1234' })

    // The pod runs as the server's uid, so a chown would only corrupt
    // host-side ownership.
    const cmds = [...mockContainerExec.mock.calls, ...mockPodExec.mock.calls].map((c) => c[1])
    expect(cmds.some((c) => c.includes('chown') || c.startsWith('sudo '))).toBe(false)
  })

  it('calls onProgress with stage messages during provisioning', async () => {
    const messages: string[] = []
    await createWorkspace('demo', {
      tool: 'claude',
      onProgress: (m) => messages.push(m),
    })
    expect(messages).toContain('Fetching latest from remote...')
    expect(messages).toContain('Ensuring container images are built...')
    expect(messages).toContain('Creating workspace from main...')
    expect(messages).toContain('Ensuring proxy deployment...')
    expect(messages.some((m) => m.startsWith('Creating session job yaac-demo-'))).toBe(true)
    expect(messages).toContain('Starting Claude Code...')
  })

  it('declares the config\'s forwards against the new job, binding nothing', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })

    const result = await createWorkspace('demo', { workspaceId: 'abcd1234' })

    // Clients bind the ports (docs/port-forward-tunnel.md); the server only
    // records them in the registry the workspace listing reads.
    expect(getWorkspacePorts('abcd1234')).toEqual([{ containerPort: 3000, hostPort: 3000 }])
    expect(result?.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('deletes the half-created Job after every failed startup attempt, including the last', async () => {
    mockWaitForPodReady.mockRejectedValue(
      new Error('workspace pod for yaac-demo-abcd1234 reached terminal phase Failed'),
    )

    await expect(createWorkspace('demo', { workspaceId: 'abcd1234' })).rejects.toThrow(
      /terminal phase Failed/,
    )

    const deleteCalls = mockKubectlRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'job')
    expect(deleteCalls).toHaveLength(3)
    for (const args of deleteCalls) {
      expect(args[2]).toBe('yaac-demo-abcd1234')
    }
  })

  it('drops a failed FRESH create\'s egress registration, but keeps a failed resume\'s', async () => {
    // A failed fresh create removes everything it made. A failed resume
    // keeps its checkout and row, and the runtime's sweeps collect the rest.
    const registrationDeletes = (): string[] => mockKubectlRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'configmap')
      .map((args) => args[2])
    mockWaitForPodReady.mockRejectedValue(new Error('pod never became ready'))

    await expect(createWorkspace('demo', { workspaceId: 'fresh1' })).rejects.toThrow()
    expect(registrationDeletes()).toContain('yaac-proxy-reg-fresh1')

    mockKubectlRetry.mockClear()
    await expect(
      createWorkspace('demo', { workspaceId: 'prior1', resume: true }),
    ).rejects.toThrow()
    expect(registrationDeletes()).toEqual([])
  })

  it('seeds claude.json onboarding flags even for non-Claude sessions (spares are retoolable)', async () => {
    await createWorkspace('demo', { tool: 'codex', workspaceId: 'abcd1234' })
    // Inside the claude home, where CLAUDE_CONFIG_DIR points.
    const claudeJsonWrite = mockWriteFile.mock.calls
      .find((c) => c[0] === '/tmp/demo/claude/.claude.json')
    expect(claudeJsonWrite).toBeDefined()
    const state = JSON.parse(claudeJsonWrite![1] as string) as Record<string, unknown>
    expect(state.hasCompletedOnboarding).toBe(true)
  })

  it('spawns one tmux new-window per InitCommandSpec entry', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'frontend', commands: ['pnpm dev:frontend'], hidePane: true },
      ],
    })

    await createWorkspace('demo', { tool: 'claude' })

    // Init windows and the agent respawn go in one exec.
    const windowsCmd = mockPodExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('new-window'))
    expect(windowsCmd).toBeDefined()
    expect(windowsCmd).toContain('-n backend')
    expect(windowsCmd).toContain('pnpm dev:backend')
    expect(windowsCmd).toContain('-n frontend')
    expect(windowsCmd).toContain('pnpm dev:frontend')

    // Only windows without hidePane keep remain-on-exit.
    expect(windowsCmd).toContain('set-option -t yaac:backend remain-on-exit on')
    expect(windowsCmd).not.toContain('yaac:frontend remain-on-exit on')
  })

  it('respawns the agent window with the tool command after tmux setup', async () => {
    await createWorkspace('demo', { tool: 'codex', workspaceId: 'abcd1234' })

    const respawn = mockPodExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    expect(respawn).toBeDefined()
    expect(respawn).toContain('-t yaac:codex')
    expect(respawn).toMatch(/'codex .* --yolo'/)
  })

  it('resumes every restored conversation in the workspace, codex\'s workspace-id pin anew', async () => {
    await createWorkspace('demo', {
      tool: 'codex',
      workspaceId: 'abcd1234',
      resume: true,
      resumeAgentSessions: [
        { agentSessionId: 'abcd1234', tool: 'codex' },
        { agentSessionId: 'conv-2', tool: 'claude' },
      ],
    })

    const windowsCmd = mockPodExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    // No codex conversation has the workspace-id pin, so `codex resume
    // abcd1234` would find nothing and kill the window. `-C` keeps a real
    // resume from asking which directory to use.
    expect(windowsCmd).toMatch(/respawn-window -k -t yaac:codex 'codex -C \/workspace [^']* --yolo'/)
    expect(windowsCmd).not.toContain('resume abcd1234')
    // claude finds a conversation by its working directory, so set `-c`.
    expect(windowsCmd).toMatch(/new-window -d -t yaac -n claude-2 -c \/workspace '[^']* --resume conv-2'/)
  })

  it('threads a model override into the claude agent respawn command', async () => {
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234', model: 'claude-opus-4-8' })

    const respawn = mockPodExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    expect(respawn).toBeDefined()
    expect(respawn).toContain('claude --permission-mode bypassPermissions --model claude-opus-4-8 --session-id abcd1234')
  })

  it('mounts the main clone read-only, at the path the server sees it at', async () => {
    // The checkout's alternates file names that path, and it fetches
    // origin/* from it without writing to it.
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const spec = appliedJobManifest().spec.template.spec
    const volume = spec.volumes.find((v) => v.hostPath?.path === '/tmp/demo/repo/.git')
    const mounts = spec.containers[0].volumeMounts
    expect(mounts.find((m) => m.name === volume?.name))
      .toMatchObject({ mountPath: '/tmp/demo/repo/.git', readOnly: true })
    expect(mounts.some((m) => m.mountPath.startsWith('/repo'))).toBe(false)
  })

  it('wires the postStart setup hook and the env that drives it', async () => {
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    // yaac-workspace-init does base setup (git identity, tmux, streamd)
    // in-pod, reading its inputs from the container env.
    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-workspace-init'] } },
      preStop: { exec: { command: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'] } },
    })
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'YAAC_TOOL', value: 'claude' },
      { name: 'YAAC_GIT_NAME', value: 'Test User' },
      { name: 'YAAC_GIT_EMAIL', value: 'test@example.com' },
      { name: 'YAAC_STATUS_RIGHT', value: ' stub-status ' },
    ]))
    // Create waits on the pod's streamd.
    expect(mockWaitForStreamd.mock.calls[0]?.[0]).toBe('yaac-demo-abcd1234')
  })

  it('rejects an init window name that collides with any agent tool window', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      // The config parser rejects this first in production; this bypasses
      // it to test validateInitWindows' own check.
      initCommands: [{ name: 'claude', commands: ['echo hi'] }],
    })
    await expect(createWorkspace('demo', { tool: 'claude' })).rejects.toThrow(
      /collides with an agent tool window/,
    )

    // Any tool name is rejected: a retooled spare renames the agent window.
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      initCommands: [{ name: 'codex', commands: ['echo hi'] }],
    })
    await expect(createWorkspace('demo', { tool: 'claude' })).rejects.toThrow(
      /collides with an agent tool window/,
    )
  })

  describe('resume mode', () => {
    it('throws VALIDATION when resume is true but no workspaceId is given', async () => {
      await expect(createWorkspace('demo', { resume: true })).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    })

    it('reuses an existing workspace instead of creating a checkout', async () => {
      mockAccess.mockResolvedValue(undefined)
      const messages: string[] = []
      await createWorkspace('demo', {
        resume: true,
        workspaceId: 'abcd1234',
        onProgress: (m) => messages.push(m),
      })
      expect(createCheckout).not.toHaveBeenCalled()
      expect(messages.some((m) => m.includes('Reusing existing workspace'))).toBe(true)
    })

    it('still creates a checkout when the workspace directory is missing', async () => {
      mockAccess.mockImplementation((target) => {
        if (typeof target === 'string' && target.includes('/workspaces/abcd1234')) {
          return Promise.reject(new Error('missing'))
        }
        return Promise.resolve(undefined)
      })
      await createWorkspace('demo', { resume: true, workspaceId: 'abcd1234' })
      expect(createCheckout).toHaveBeenCalledTimes(1)
    })
  })

  it('mounts the per-session opencode working copy, its global checkpoint, and the shared config dir on every session', async () => {
    // Mounted whatever the tool, since spares can be retooled.
    await createWorkspace('demo', { tool: 'claude', workspaceId: 'abcd1234' })

    const { volumes, containers } = appliedJobManifest().spec.template.spec

    // The node-local working copy, keyed by the project's id.
    const dataVol = volumes.find((v) => v.hostPath?.path === `/tmp/node/${projectRow('').id}/opencode-data/abcd1234`)
    expect(dataVol).toBeDefined()
    const dataMount = containers[0].volumeMounts
      .find((m) => m.mountPath === '/home/yaac/.local/share/opencode')
    expect(dataMount?.name).toBe(dataVol?.name)
    // The shared checkpoint it is restored from and saved back to by the
    // preStop hook. The working copy is on the pod's node, so the server
    // does not create it.
    const checkpointVol = volumes.find((v) => v.hostPath?.path === '/tmp/demo/opencode-data/abcd1234')
    expect(checkpointVol).toBeDefined()
    expect(containers[0].volumeMounts.find((m) => m.mountPath === '/home/yaac/.yaac/opencode-checkpoint')?.name)
      .toBe(checkpointVol?.name)
    expect(containers[0].lifecycle?.preStop).toEqual({
      exec: { command: ['/usr/local/bin/yaac-opencode-checkpoint', 'stop'] },
    })
    expect(mockMkdir).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/node\//), expect.anything(),
    )

    const configVol = volumes.find((v) => v.hostPath?.path === '/tmp/demo/opencode-config')
    expect(configVol).toBeDefined()
    const configMount = containers[0].volumeMounts
      .find((m) => m.mountPath === '/home/yaac/.config/opencode')
    expect(configMount?.name).toBe(configVol?.name)

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/opencode-data/abcd1234', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/opencode-config', { recursive: true })
  })
})

describe('buildAgentCmd', () => {
  // Strips codex's `-c` settings, which the server's own tests cover.
  const bare = (cmd: string): string => cmd.replace(/ -c "(?:[^"\\]|\\.)*"/g, '')

  it('returns the codex respawn command unchanged', () => {
    const fresh = buildAgentCmd({ tool: 'codex', workspaceId: 'sid-abc', permissionMode: 'bypass' })
    expect(bare(fresh)).toBe('codex --dangerously-bypass-hook-trust --yolo')
    const resume = buildAgentCmd({
      tool: 'codex', workspaceId: 'sid-abc', resume: true, permissionMode: 'bypass',
    })
    expect(bare(resume)).toBe('codex --dangerously-bypass-hook-trust --yolo resume sid-abc')
  })

  // Without `env -u TMUX`, claude stops animating its title, which is how
  // yaac reads its status (see buildAgentCmd).
  it('returns the claude respawn command unchanged, $TMUX hidden', () => {
    const fresh = buildAgentCmd({ tool: 'claude', workspaceId: 'sid-abc', permissionMode: 'bypass' })
    expect(fresh).toBe(
      'env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --session-id sid-abc',
    )
    const resume = buildAgentCmd({
      tool: 'claude', workspaceId: 'sid-abc', resume: true, permissionMode: 'bypass',
    })
    expect(resume).toBe(
      'env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --resume sid-abc',
    )
  })

  it('asks for approval in each tool\'s own spelling under manual', () => {
    // codex has no ask-before-everything mode; read-only is the closest.
    expect(bare(buildAgentCmd({ tool: 'codex', workspaceId: 'sid-abc', permissionMode: 'manual' })))
      .toBe('codex --dangerously-bypass-hook-trust --sandbox read-only')
    expect(buildAgentCmd({ tool: 'claude', workspaceId: 'sid-abc', permissionMode: 'manual' }))
      .toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode manual --session-id sid-abc')
  })

  it('launches opencode over a private server of its own, with its posture in the env', () => {
    const fresh = buildAgentCmd({ tool: 'opencode', workspaceId: 'sid-abc', permissionMode: 'bypass' })
    expect(fresh).toMatch(/^OPENCODE_CONFIG_CONTENT="\{.*\}" opencode --standalone$/)
  })

  it('resumes an opencode session by its id', () => {
    const resume = buildAgentCmd({
      tool: 'opencode', workspaceId: 'sid-abc', resume: true, permissionMode: 'bypass',
    })
    expect(resume).toMatch(/ opencode --standalone --session sid-abc$/)
  })
})

describe('retoolSpare', () => {
  const spare = { jobName: 'yaac-demo-spare1', workspaceId: 'spare1', tool: 'claude' }

  /** Commands the retool ran, in order. */
  let execs: Array<[string, string, { timeout?: number; maxAttempts?: number } | undefined]>

  beforeEach(() => {
    vi.resetAllMocks()
    execs = []
    installFakeWorkspaceDriver({
      exec: (jobName, cmd, opts) => {
        execs.push([jobName, cmd, opts])
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
  })

  it('renames + respawns the agent window for the new tool', async () => {
    await retoolSpare(spare, { tool: 'codex', permissionMode: 'bypass', mode: 'tui' })

    const cmds = execs.map((c) => c[1])
    expect(cmds.some((c) => c.includes('rename-window -t yaac:claude codex'))).toBe(true)
    const respawn = cmds.find((c) => c.includes('respawn-window'))
    expect(respawn).toContain('-t yaac:codex')
    expect(respawn).toMatch(/'codex .* --yolo'/)
    // The rename may be retried, so it succeeds if already applied.
    const rename = cmds.find((c) => c.includes('rename-window'))!
    expect(rename).toContain('|| ')
    expect(rename).toContain('grep -qxF codex')
    expect(execs.every((c) => c[2]?.maxAttempts === undefined)).toBe(true)
  })

  it('boots the new agent with the spare\'s own session id', async () => {
    await retoolSpare({ ...spare, tool: 'codex' }, { tool: 'claude', permissionMode: 'bypass', mode: 'tui' })

    const respawn = execs.map((c) => c[1]).find((c) => c.includes('respawn-window'))
    expect(respawn).toContain('-t yaac:claude')
    expect(respawn).toContain('--session-id spare1')
  })

  it('respawns the agent with the requested model and posture', async () => {
    await retoolSpare(spare, { tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'tui' })

    const respawn = execs.map((c) => c[1]).find((c) => c.includes('respawn-window'))
    expect(respawn).toContain('--model claude-opus-5-5')
    expect(respawn).toContain('--permission-mode plan')
  })
})

describe('resolveInitWindows', () => {
  it('returns [] when initCommands is unset or empty', () => {
    expect(resolveInitWindows({})).toEqual([])
    expect(resolveInitWindows({ initCommands: [] })).toEqual([])
  })

  it('collapses a string list into a single init window with &&-joined cmd', () => {
    const windows = resolveInitWindows({ initCommands: ['pnpm install', 'pnpm build'] })
    expect(windows).toEqual([
      { name: 'init', cmd: 'pnpm install && pnpm build', hidePane: false },
    ])
  })

  it('inherits the top-level hideInitPane on the string-form window', () => {
    const windows = resolveInitWindows({
      initCommands: ['pnpm install'],
      hideInitPane: true,
    })
    expect(windows[0]?.hidePane).toBe(true)
  })

  it('produces one window per object entry, &&-joining commands within each', () => {
    const windows = resolveInitWindows({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'frontend', commands: ['pnpm install', 'pnpm dev:frontend'] },
      ],
    })
    expect(windows).toEqual([
      { name: 'backend', cmd: 'pnpm dev:backend', hidePane: false },
      { name: 'frontend', cmd: 'pnpm install && pnpm dev:frontend', hidePane: false },
    ])
  })

  it('per-window hidePane overrides the top-level default', () => {
    const windows = resolveInitWindows({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'install', commands: ['pnpm install'], hidePane: true },
      ],
      hideInitPane: false,
    })
    expect(windows.map((w) => [w.name, w.hidePane])).toEqual([
      ['backend', false],
      ['install', true],
    ])
  })

  it('shell-escapes single quotes in command strings', () => {
    const windows = resolveInitWindows({ initCommands: ["echo 'hi'"] })
    expect(windows[0]?.cmd).toBe("echo '\\''hi'\\''")
  })
})

import type * as allowedHostsModule from '@yaac/server/lib/allowed-hosts'
import type * as imageBuilderModule from '@yaac/server/drivers/k8s/image-engine/image-builder'
import type * as buildCoordinatorModule from '@yaac/server/drivers/k8s/images/build-coordinator'
import type * as kubectlModule from '@yaac/server/drivers/k8s/substrate/kubectl'
import type * as execModule from '@yaac/server/drivers/k8s/substrate/exec'
import type * as projectConfigModule from '@yaac/server/domain/projects/config'
import type * as credentialsModule from '@yaac/server/domain/projects/credentials'
import type * as projectStoreModule from '@yaac/server/db/project-store'
import type * as gitModule from '@yaac/server/domain/git'
import type * as portForwardersModule from '@yaac/server/drivers/k8s/forwarders/port-forwarders'
import type * as storeModule from '@yaac/server/db/workspace-store'
import type * as agentStoreModule from '@yaac/server/db/agent-session-store'
import type * as preferencesModule from '@yaac/server/db/preferences'
import type * as cleanupModule from '@yaac/server/domain/workspaces/cleanup'

// /workspace/create streams NDJSON, so the `api` client returns the raw
// Response for `consumeNdjsonStream`.
const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}))
vi.mock('#commands/api', () => ({
  api: { workspace: { create: { $post: mockPost } } },
}))

function streamingResponse(lines: string[]): { ok: true; body: ReadableStream<Uint8Array> } {
  const enc = new TextEncoder()
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(enc.encode(line + '\n'))
        controller.close()
      },
    }),
  }
}

describe('workspaceCreate (CLI shim)', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  beforeEach(() => {
    vi.resetAllMocks()
    logSpy.mockClear()

    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'progress', message: 'Creating session job yaac-demo-sess-123...' }),
      JSON.stringify({
        type: 'result',
        result: {
          workspaceId: 'sess-123',
          jobName: 'yaac-demo-sess-123',
          forwardedPorts: [],
          tool: 'claude',
        },
      }),
    ]))
  })

  it('POSTs /workspace/create and attaches to the workspace it made', async () => {
    await workspaceCreate('demo', {})
    expect(attachWorkspacePty).toHaveBeenCalledWith('sess-123', 'native')
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({
        project: 'demo',
        // Omitted so the server picks the default.
        tool: undefined,
      }) as unknown,
    }))
    // The git identity is a server setting, not a request field.
    const [{ json }] = mockPost.mock.calls[0] as [{ json: Record<string, unknown> }]
    expect(json.gitUser).toBeUndefined()
  })

  it('forwards an explicit --tool unchanged', async () => {
    await workspaceCreate('demo', { tool: 'codex' })
    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({ tool: 'codex' }) as unknown,
    }))
  })

  it('prints each progress message from the NDJSON stream', async () => {
    await workspaceCreate('demo', {})
    const logged = logSpy.mock.calls.map((args) => args[0] as unknown).filter((v) => typeof v === 'string')
    expect(logged).toContain('Fetching latest from remote...')
    expect(logged).toContain('Creating session job yaac-demo-sess-123...')
  })

  it('throws with the server error message when the stream carries an error event', async () => {
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'error', error: { code: 'VALIDATION', message: 'no github token' } }),
    ]))
    await expect(workspaceCreate('demo', {})).rejects.toThrow('no github token')
  })
})
