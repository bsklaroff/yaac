import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('missing')),
    chmod: vi.fn().mockResolvedValue(undefined),
    // Built-in skill staging: rm the stage dir, list (readdir) the bundled
    // skills, cp each across. An empty readdir stages nothing. Session-bin
    // staging copyFiles each listed script.
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    cp: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    remote: vi.fn().mockResolvedValue('https://github.com/example/repo.git'),
    addConfig: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@yaac/server/platform/container/runtime', () => ({
  ensureContainerRuntime: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof runtimeModule>))

vi.mock('@yaac/server/features/images/image-builder', () => ({
  sessionUid: vi.fn(() => 1000),
} satisfies Partial<typeof imageBuilderModule>))

vi.mock('@yaac/server/features/images/build-coordinator', () => ({
  ensureImage: vi.fn().mockResolvedValue('yaac-test-image'),
  pushImageShared: vi.fn().mockResolvedValue('localhost:5000/yaac-test-image'),
} satisfies Partial<typeof buildCoordinatorModule>))

vi.mock('@yaac/server/platform/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
} satisfies Partial<typeof kubectlModule>))

// Keep bootstrap real except proxyServiceClusterIp, which would otherwise hit
// the (pod-shaped) kubectlGetJson mock and throw — the pod's DNS nameserver is
// the live proxy ClusterIP read here.
vi.mock('@yaac/server/features/cluster/proxy-apply', async (importOriginal) => ({
  ...(await importOriginal()),
  proxyServiceClusterIp: vi.fn().mockResolvedValue('10.96.0.5'),
}))

vi.mock('@yaac/server/platform/k8s/exec', () => ({
  containerExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
} satisfies Partial<typeof execModule>))

// The CLI command attaches over the server PTY WebSocket after
// provisioning — mock the transport so no socket is opened.
vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/server/features/sessions/egress/proxy-client', () => ({
  SSH_AGENT_MOUNT: '/ssh-agent',
  SSH_AGENT_SOCKET_PATH: '/ssh-agent/socket',
  proxyClient: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    registerSession: vi.fn().mockResolvedValue(undefined),
    getCaTrustEnv: vi.fn().mockReturnValue(['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem']),
    getCaCert: vi.fn().mockResolvedValue('cert'),
  },
  buildRulesFromConfig: vi.fn().mockReturnValue([]),
  collectProxySecrets: vi.fn().mockReturnValue({}),
  // NOT tsc-guarded: the mocked `proxyClient` is a deliberate 4-method subset
  // of the 26-member `ProxyClient` class, which `satisfies Partial<…>` rejects
  // (a partial object value is not assignable to the full property type).
}))

vi.mock('@yaac/server/features/sessions/egress/default-allowed-hosts', async (importOriginal) => {
  const actual = await importOriginal<typeof allowedHostsModule>()
  return {
    ...actual,
    // Default to '*' so session-create's allowlist hard-check passes.
    // Tests that need a specific allowlist can override per-test.
    resolveAllowedHosts: vi.fn().mockReturnValue(['*']),
  }
})

vi.mock('@yaac/server/platform/container/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn().mockReturnValue(vi.fn()),
} satisfies Partial<typeof portModule>))

vi.mock('@yaac/server/platform/k8s/stream-relay', () => ({
  bootStreamd: vi.fn().mockResolvedValue(undefined),
  relayTcpFactory: vi.fn().mockReturnValue(() => ({})),
  sessionStreamToken: vi.fn().mockResolvedValue('stream-token'),
  sessionExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  waitForStreamd: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/server/platform/k8s/pod-wait', () => ({
  waitForJobPodReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/shared/project-paths', () => ({
  repoDir: vi.fn((slug: string) => `/tmp/${slug}/repo`),
  claudeDir: vi.fn((slug: string) => `/tmp/${slug}/claude`),
  claudeJsonFile: vi.fn((slug: string) => `/tmp/${slug}/claude.json`),
  codexDir: vi.fn((slug: string) => `/tmp/${slug}/codex`),
  opencodeConfigDir: vi.fn((slug: string) => `/tmp/${slug}/opencode-config`),
  opencodeDataDir: vi.fn((slug: string, sessionId: string) => `/tmp/${slug}/opencode-data/${sessionId}`),
  piDir: vi.fn((slug: string) => `/tmp/${slug}/pi`),
  cachedPackagesDir: vi.fn((slug: string) => `/tmp/${slug}/.cached-packages`),
  cacheVolumeDir: vi.fn((slug: string, key: string) => `/tmp/${slug}/cache-volumes/${key}`),
  codexTranscriptDir: vi.fn((slug: string) => `/tmp/${slug}/transcripts`),
  worktreeDir: vi.fn((slug: string, sessionId: string) => `/tmp/${slug}/worktrees/${sessionId}`),
  worktreesDir: vi.fn((slug: string) => `/tmp/${slug}/worktrees`),
  projectDir: vi.fn((slug: string) => `/tmp/${slug}`),
  sessionDir: vi.fn((slug: string, sid: string) => `/tmp/${slug}/sessions/${sid}`),
  sessionTmuxDir: vi.fn((slug: string, sid: string) => `/tmp/${slug}/sessions/${sid}/tmux`),
  sessionVclusterDir: vi.fn((slug: string, sid: string) => `/tmp/${slug}/sessions/${sid}/vcluster`),
  nestedYaacDataDir: vi.fn((slug: string, sid: string) => `/tmp/${slug}/sessions/${sid}/nested-yaac`),
  credentialsDir: vi.fn(() => '/tmp/yaac-data/.credentials'),
  getDataDir: vi.fn(() => '/tmp/yaac-data'),
  PACKAGE_ROOT: '/tmp/yaac-package',
}))

vi.mock('@yaac/server/features/projects/config', () => ({
  resolveProjectConfig: vi.fn().mockResolvedValue({}),
  resolveEphemeralModulesPaths: () => [],
  ephemeralModulesSlotKey: (p: string) => (p === 'node_modules' ? 'root' : p.replace(/\//g, '_')),
} satisfies Partial<typeof projectConfigModule>))

vi.mock('@yaac/server/features/projects/credentials', () => ({
  resolveCredentialForUrl: vi.fn().mockResolvedValue({ kind: 'https', token: 'token' }),
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
  loadKnownHostsEntryForHost: vi.fn().mockResolvedValue(null),
  writeProxySecrets: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@yaac/server/platform/git', () => ({
  addWorktree: vi.fn().mockResolvedValue(undefined),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  remoteBranchExists: vi.fn().mockResolvedValue(true),
  writeKnownHostsFile: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof gitModule>))

vi.mock('@yaac/shared/git', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGitModule>()
  return {
    ...actual,
    getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
  }
})

vi.mock('@yaac/server/features/sessions/agents/codex', () => ({
  removeLegacyCodexHook: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof codexAgentModule>))

vi.mock('@yaac/server/features/sessions/agents/opencode', () => ({
  ensureOpencodeConfigJson: vi.fn().mockResolvedValue(undefined),
} satisfies Partial<typeof opencodeAgentModule>))

vi.mock('@yaac/server/features/sessions/forwarders/port-forwarders', () => ({
  buildStatusRight: vi.fn().mockReturnValue(' stub-status '),
  registerSessionForwarders: vi.fn(),
} satisfies Partial<typeof portForwardersModule>))

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createSession } from '@yaac/server/features/sessions/create'
import { buildAgentCmd, resolveInitWindows } from '@yaac/server/features/sessions/agent-command'
import { retoolSpare } from '@yaac/server/features/sessions/spare-pool'
import { sessionCreate } from '#commands/session-create'
import { ensureContainerRuntime } from '@yaac/server/platform/container/runtime'
import { ensureImage, pushImageShared } from '@yaac/server/features/images/build-coordinator'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@yaac/server/platform/k8s/kubectl'
import { containerExec } from '@yaac/server/platform/k8s/exec'
import { proxyServiceClusterIp } from '@yaac/server/features/cluster/proxy-apply'
import { proxyClient } from '@yaac/server/features/sessions/egress/proxy-client'
import { resolveProjectConfig } from '@yaac/server/features/projects/config'
import simpleGit from 'simple-git'
import { resolveCredentialForUrl, loadKnownHostsEntryForHost } from '@yaac/server/features/projects/credentials'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import { resolveAllowedHosts } from '@yaac/server/features/sessions/egress/default-allowed-hosts'
import { addWorktree, getDefaultBranch, fetchOrigin, remoteBranchExists } from '@yaac/server/platform/git'
import { reserveAvailablePort, startPortForwarders } from '@yaac/server/platform/container/port'
import { relayTcpFactory, sessionExec, waitForStreamd } from '@yaac/server/platform/k8s/stream-relay'
import { waitForJobPodReady } from '@yaac/server/platform/k8s/pod-wait'
import { buildStatusRight, registerSessionForwarders } from '@yaac/server/features/sessions/forwarders/port-forwarders'

const mockSpawn = vi.mocked(spawn)
const mockAccess = vi.mocked(fs.access)
const mockMkdir = vi.mocked(fs.mkdir)
const mockWriteFile = vi.mocked(fs.writeFile)
const mockReadFile = vi.mocked(fs.readFile)
const mockReaddir = vi.mocked(fs.readdir)
const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockKubectlRetry = vi.mocked(kubectlWithRetry)
const mockContainerExec = vi.mocked(containerExec)
const mockSessionExec = vi.mocked(sessionExec)
const mockWaitForStreamd = vi.mocked(waitForStreamd)
const mockWaitForPodReady = vi.mocked(waitForJobPodReady)
const mockReserveAvailablePort = vi.mocked(reserveAvailablePort)
const mockStartForwarders = vi.mocked(startPortForwarders)
const mockRelayTcpFactory = vi.mocked(relayTcpFactory)
const mockRegisterSessionForwarders = vi.mocked(registerSessionForwarders)
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
          lifecycle?: { postStart?: { exec?: { command: string[] } } }
          volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
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

describe('createSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()

    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockReadFile.mockRejectedValue(new Error('missing'))
    // resetAllMocks strips the module-mock impls: re-prime readdir so the
    // built-in skill staging sees "no bundled skills", while session-bin
    // staging finds the mandatory postStart script (createSession refuses
    // to provision without yaac-session-init).
    mockReaddir.mockImplementation(((dir: string) => Promise.resolve(
      dir === '/tmp/yaac-package/session-bin'
        ? [{ name: 'yaac-session-init', isFile: () => true }]
        : [],
    )) as never)
    vi.mocked(ensureContainerRuntime).mockResolvedValue(undefined)
    vi.mocked(ensureImage).mockResolvedValue('yaac-test-image')
    vi.mocked(pushImageShared).mockResolvedValue('localhost:5000/yaac-test-image')
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(resolveCredentialForUrl).mockResolvedValue({ kind: 'https', token: 'token' } as never)
    vi.mocked(resolveAllowedHosts).mockReturnValue(['*'])
    vi.mocked(addWorktree).mockResolvedValue(undefined)
    vi.mocked(getDefaultBranch).mockResolvedValue('main')
    vi.mocked(fetchOrigin).mockResolvedValue(undefined)
    vi.mocked(remoteBranchExists).mockResolvedValue(true)
    vi.mocked(getGitUserConfigShared).mockResolvedValue({ name: 'Test User', email: 'test@example.com' })
    mockLoadToolAuth.mockResolvedValue(null)
    vi.mocked(proxyServiceClusterIp).mockResolvedValue('10.96.0.5')
    /* eslint-disable @typescript-eslint/unbound-method */
    vi.mocked(proxyClient.ensureRunning).mockResolvedValue(undefined)
    vi.mocked(proxyClient.registerSession).mockResolvedValue(undefined)
    vi.mocked(proxyClient.getCaTrustEnv).mockReturnValue(['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem'])
    /* eslint-enable @typescript-eslint/unbound-method */
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockApply.mockResolvedValue(undefined)
    mockGetJson.mockResolvedValue(null)
    // Pod boot + streamd default to healthy so the flow runs straight
    // through. Failure tests override waitForJobPodReady.
    mockWaitForPodReady.mockResolvedValue(undefined)
    mockWaitForStreamd.mockResolvedValue(undefined)
    mockKubectlRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockSessionExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockStartForwarders.mockReturnValue(vi.fn())
    mockRelayTcpFactory.mockReturnValue((() => ({})) as never)
    vi.mocked(buildStatusRight).mockReturnValue(' stub-status ')
    mockReserveAvailablePort.mockResolvedValue({
      containerPort: 3000,
      hostPort: 3000,
      server: { close: vi.fn() },
    } as never)
  })

  it('creates the worktree from an explicitly requested branch and tracks it', async () => {
    const result = await createSession('demo', { tool: 'claude', branch: 'dev' })
    expect(vi.mocked(addWorktree)).toHaveBeenCalledWith(
      '/tmp/demo/repo',
      `/tmp/demo/worktrees/${result?.sessionId}`,
      `agent/${result?.sessionId}`,
      'origin/dev',
    )
    const upstreamCall = mockSessionExec.mock.calls.find(([, cmd]) => cmd.includes('--set-upstream-to'))
    expect(upstreamCall?.[1]).toContain("'origin/dev'")
  })

  it('falls back to the configured referenceBranch, with an explicit branch winning', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({ referenceBranch: 'develop' })
    await createSession('demo', { tool: 'claude' })
    expect(vi.mocked(addWorktree)).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'origin/develop',
    )

    await createSession('demo', { tool: 'claude', branch: 'dev' })
    expect(vi.mocked(addWorktree)).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'origin/dev',
    )
    expect(vi.mocked(getDefaultBranch)).not.toHaveBeenCalled()
  })

  it('rejects a requested branch missing from origin, naming the source', async () => {
    vi.mocked(remoteBranchExists).mockResolvedValue(false)
    await expect(createSession('demo', { tool: 'claude', branch: 'ghost' }))
      .rejects.toThrow(/branch "ghost" not found on origin — check the requested branch/)

    vi.mocked(resolveProjectConfig).mockResolvedValue({ referenceBranch: 'ghost' })
    await expect(createSession('demo', { tool: 'claude' }))
      .rejects.toThrow(/check referenceBranch in yaac-config\.json/)
    expect(vi.mocked(addWorktree)).not.toHaveBeenCalled()
  })

  it('a bad branch fails fast: one Job apply, one delete, no recreate retries', async () => {
    // Worktree-leg failures are the create's inputs being bad, never the
    // pod's — SetupInputError must skip the 3-attempt Job-recreate loop.
    vi.mocked(remoteBranchExists).mockResolvedValue(false)
    await expect(createSession('demo', { tool: 'claude', branch: 'ghost', sessionId: 'abcd1234' }))
      .rejects.toThrow(/branch "ghost" not found/)

    expect(mockApply).toHaveBeenCalledTimes(1)
    const deleteCalls = mockKubectlRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete' && args[1] === 'job')
    expect(deleteCalls).toHaveLength(1)
  })

  it('returns a session descriptor with the job name, without attaching', async () => {
    const result = await createSession('demo', { tool: 'codex' })

    expect(result).toBeDefined()
    expect(result?.sessionId).toEqual(expect.any(String))
    expect(result?.jobName).toBe(`yaac-demo-${result?.sessionId}`)
    expect(result?.tool).toBe('codex')
    expect(result?.forwardedPorts).toEqual([])
    expect(mockApply).toHaveBeenCalledTimes(1)
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
    await createSession('demo', { tool: 'opencode', sessionId: 'abcd1234' })

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
    await createSession('demo', { tool: 'opencode', sessionId: 'abcd1234' })

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
    await createSession('demo', { tool: 'pi', sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    // anthropic provider → ANTHROPIC_API_KEY placeholder (claude is unconfigured here).
    expect(env).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' })
    // pi session-log dir + version-check skip are seeded unconditionally.
    expect(env).toContainEqual({ name: 'PI_CODING_AGENT_SESSION_DIR', value: '/home/yaac/.pi/agent/sessions' })
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
    await createSession('demo', { tool: 'pi', sessionId: 'abcd1234' })

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
    await createSession('demo', { tool: 'codex', sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    // A codex session still carries the other tools' placeholders…
    expect(env).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' })
    expect(env).toContainEqual({ name: 'OPENROUTER_API_KEY', value: 'test-placeholder-key' })
    expect(env).toContainEqual({ name: 'OPENCODE_ENABLE_EXA', value: 'true' })
    expect(env).toContainEqual({ name: 'OPENCODE_DISABLE_AUTOUPDATE', value: '1' })
    // …but no OPENAI_API_KEY: codex has no credential here, and for codex
    // OAuth the var would steer it into api-key mode.
    expect(env.map((e) => e.name)).not.toContain('OPENAI_API_KEY')
  })

  it('seeds OPENAI_API_KEY only for a codex api-key credential, never for codex OAuth', async () => {
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'codex' ? {
      tool: 'codex',
      kind: 'oauth',
      apiKey: 'access-token',
      savedAt: new Date().toISOString(),
    } as never : null))
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })
    expect(appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name))
      .not.toContain('OPENAI_API_KEY')

    mockApply.mockClear()
    mockLoadToolAuth.mockImplementation((tool) => Promise.resolve(tool === 'codex' ? {
      tool: 'codex',
      kind: 'api-key',
      apiKey: 'sk-real',
      savedAt: new Date().toISOString(),
    } as never : null))
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1235' })
    expect(appliedJobManifest().spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'OPENAI_API_KEY', value: 'test-placeholder-key' })
  })

  it('refuses vcluster-in-vcluster: virtualCluster under YAAC_NESTED=1', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      virtualCluster: true,
      nestedContainers: true,
    })
    process.env.YAAC_NESTED = '1'
    try {
      await expect(createSession('demo', { tool: 'claude' }))
        .rejects.toThrow(/vcluster-in-vcluster/)
    } finally {
      delete process.env.YAAC_NESTED
    }
  })

  it('applies a Job manifest with session labels, the registry image ref, and shared mounts', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const manifest = appliedJobManifest()
    expect(manifest.metadata.name).toBe('yaac-demo-abcd1234')
    expect(manifest.metadata.namespace).toBe('yaac')

    const labels = {
      'yaac.project': 'demo',
      'yaac.session-id': 'abcd1234',
      'yaac.data-dir-hash': 'ddh0123456789abc',
      'yaac.tool': 'claude',
    }
    expect(manifest.metadata.labels).toEqual(labels)
    expect(manifest.spec.template.metadata.labels).toEqual(labels)
    expect(manifest.spec.backoffLimit).toBe(0)
    expect(manifest.spec.template.spec.restartPolicy).toBe('Never')

    const container = manifest.spec.template.spec.containers[0]
    // The image ref is the registry push result, not the local tag.
    expect(container.image).toBe('localhost:5000/yaac-test-image')
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'YAAC_SESSION_ID', value: 'abcd1234' },
      { name: 'SSL_CERT_FILE', value: '/etc/yaac/certs/proxy-ca.pem' },
    ]))
    // Routing env vars are gone — interception is transparent.
    const envNames = container.env.map((e) => e.name)
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      expect(envNames).not.toContain(name)
    }

    const hostPaths = manifest.spec.template.spec.volumes
      .filter((v) => v.hostPath)
      .map((v) => v.hostPath!.path)
    expect(hostPaths).toEqual(expect.arrayContaining([
      '/tmp/demo/worktrees/abcd1234',
      '/tmp/demo/repo/.git',
      '/tmp/demo/claude',
      '/tmp/demo/claude.json',
      '/tmp/demo/codex',
      '/tmp/demo/opencode-data/abcd1234',
      '/tmp/demo/opencode-config',
      '/tmp/demo/pi',
      '/tmp/demo/.cached-packages',
      '/tmp/demo/sessions/abcd1234/tmux',
    ]))
    // ~/.claude.json is a single file — hostPath type File.
    const claudeJsonVol = manifest.spec.template.spec.volumes
      .find((v) => v.hostPath?.path === '/tmp/demo/claude.json')
    expect(claudeJsonVol?.hostPath?.type).toBe('File')

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/claude', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/codex', { recursive: true })
  })

  it('injects no per-pod egress sidecars and points the pod resolver at the proxy', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const spec = appliedJobManifest().spec.template.spec
    // Egress is redirected at the node level (netd's veth-peer DNAT) — the
    // Job carries no redirect-init/relay init containers.
    expect(spec.initContainers).toBeUndefined()
    // The pod resolves DNS against the proxy Service's stub at its live
    // (allocator-assigned) ClusterIP, read via proxyServiceClusterIp;
    // identity is the source pod IP the proxy watches, so no token.
    expect(spec.dnsPolicy).toBe('None')
    expect(proxyServiceClusterIp).toHaveBeenCalled()
    expect(spec.dnsConfig).toEqual({ nameservers: ['10.96.0.5'] })
    const sessionEnvNames = spec.containers[0].env.map((e: { name: string }) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
    // No bind endpoint exists — identity is stateless at the proxy.
    expect(proxyClient).not.toHaveProperty('relayToken')
  })

  it('routes SSH through the redirected tunnel sentinel with no credential', async () => {
    // SSH-scheme remote: ncat CONNECTs to the sentinel address that netd
    // redirects to the proxy tunnel listener, carrying no proxy-auth — so
    // identity is the source pod IP (not a leakable bearer credential).
    vi.mocked(simpleGit).mockReturnValue({
      remote: vi.fn().mockResolvedValue('git@github.com:example/repo.git'),
      addConfig: vi.fn().mockResolvedValue(undefined),
    } as never)
    vi.mocked(loadKnownHostsEntryForHost).mockResolvedValue('github.com ssh-ed25519 AAAAC3')

    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    const sshCmd = env.find((e) => e.name === 'GIT_SSH_COMMAND')?.value ?? ''
    expect(sshCmd).toContain('ncat --proxy 198.18.0.2:10259')
    expect(sshCmd).toContain('--proxy-type http')
    // No bearer credential rides the workload env.
    expect(sshCmd).not.toContain('--proxy-auth')
    expect(sshCmd).not.toContain('x:')
    expect(sshCmd).not.toContain('abcd1234')
  })

  it('adds the placeholder API key env for claude api-key auth', async () => {
    mockLoadToolAuth.mockImplementation((tool) =>
      Promise.resolve(tool === 'claude' ? { kind: 'api-key' } as never : null))

    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'ANTHROPIC_API_KEY', value: 'test-placeholder-key' },
    ]))
  })

  it('seeds a placeholder GH_TOKEN for an HTTPS github.com remote', async () => {
    await createSession('demo', { sessionId: 'abcd1234' })

    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'GH_TOKEN', value: 'test-placeholder-gh-token' },
    ]))
  })

  it('does not seed GH_TOKEN for a non-GitHub HTTPS remote', async () => {
    vi.mocked(simpleGit).mockReturnValue({
      remote: vi.fn().mockResolvedValue('https://gitlab.com/example/repo.git'),
    } as never)

    await createSession('demo', { sessionId: 'abcd1234' })

    const envNames = appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name)
    expect(envNames).not.toContain('GH_TOKEN')
  })

  it('does not override an explicit GH_TOKEN from project config', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({ env: { GH_TOKEN: 'ghp_user' } })

    await createSession('demo', { sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env.find((e) => e.name === 'GH_TOKEN')?.value).toBe('ghp_user')
  })

  it('defers to an envSecretProxy GITHUB_TOKEN rule instead of auto-wiring gh', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      envSecretProxy: { GITHUB_TOKEN: { hosts: ['api.github.com'] } },
    } as never)

    await createSession('demo', { sessionId: 'abcd1234' })

    const envNames = appliedJobManifest().spec.template.spec.containers[0].env.map((e) => e.name)
    expect(envNames).not.toContain('GH_TOKEN')
  })

  it('never chowns mounts in-container — uid alignment makes server dirs writable', async () => {
    await createSession('demo', { sessionId: 'abcd1234' })

    // The image's yaac user carries the server's uid (YAAC_UID build arg),
    // so server-created hostPath dirs are writable without privileged
    // fixups. A chown here would also corrupt host-side ownership on
    // Linux (idmapped mounts write the pod's userns uid through).
    const cmds = [...mockContainerExec.mock.calls, ...mockSessionExec.mock.calls].map((c) => c[1])
    expect(cmds.some((c) => c.includes('chown') || c.startsWith('sudo '))).toBe(false)
  })

  it('calls onProgress with stage messages during provisioning', async () => {
    const messages: string[] = []
    await createSession('demo', {
      tool: 'claude',
      onProgress: (m) => messages.push(m),
    })
    expect(messages).toContain('Fetching latest from remote...')
    expect(messages).toContain('Ensuring container images are built...')
    expect(messages).toContain('Pushing session image to the local registry...')
    expect(messages).toContain('Creating worktree from main...')
    expect(messages).toContain('Ensuring proxy deployment...')
    expect(messages.some((m) => m.startsWith('Creating session job yaac-demo-'))).toBe(true)
    expect(messages).toContain('Starting Claude Code...')
  })

  it('reserves, starts, and registers port forwarders for the new job', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    const reserved = { containerPort: 3000, hostPort: 3001, server: { close: vi.fn() } }
    mockReserveAvailablePort.mockResolvedValueOnce(reserved as never)
    const relayFactory = (() => ({})) as never
    mockRelayTcpFactory.mockReturnValue(relayFactory)

    const result = await createSession('demo', { sessionId: 'abcd1234' })

    expect(mockReserveAvailablePort).toHaveBeenCalledWith(3000, 3000)
    expect(mockRelayTcpFactory).toHaveBeenCalledWith('abcd1234')
    expect(mockStartForwarders).toHaveBeenCalledWith(relayFactory, [reserved])
    expect(mockRegisterSessionForwarders).toHaveBeenCalledWith(
      'abcd1234', expect.any(Function), [reserved],
    )
    expect(result?.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3001 }])
  })

  it('deletes the half-created Job after every failed startup attempt, including the last', async () => {
    // The pod-ready watch sees a terminal pod on every attempt.
    mockWaitForPodReady.mockRejectedValue(
      new Error('session pod for yaac-demo-abcd1234 reached terminal phase Failed'),
    )

    await expect(createSession('demo', { sessionId: 'abcd1234' })).rejects.toThrow(
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

  it('seeds claude.json onboarding flags even for non-Claude sessions (spares are retoolable)', async () => {
    await createSession('demo', { tool: 'codex', sessionId: 'abcd1234' })
    const claudeJsonWrite = mockWriteFile.mock.calls.find((c) => c[0] === '/tmp/demo/claude.json')
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

    await createSession('demo', { tool: 'claude' })

    // Init windows + the agent respawn travel as ONE relay exec.
    const windowsCmd = mockSessionExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('new-window'))
    expect(windowsCmd).toBeDefined()
    expect(windowsCmd).toContain('-n backend')
    expect(windowsCmd).toContain('pnpm dev:backend')
    expect(windowsCmd).toContain('-n frontend')
    expect(windowsCmd).toContain('pnpm dev:frontend')

    // backend defaults to hidePane=false → keeps remain-on-exit; frontend
    // sets hidePane=true → no remain-on-exit.
    expect(windowsCmd).toContain('set-option -t yaac:backend remain-on-exit on')
    expect(windowsCmd).not.toContain('yaac:frontend remain-on-exit on')
  })

  it('respawns the agent window with the tool command after tmux setup', async () => {
    await createSession('demo', { tool: 'codex', sessionId: 'abcd1234' })

    const respawn = mockSessionExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    expect(respawn).toBeDefined()
    expect(respawn).toContain('-t yaac:codex')
    expect(respawn).toContain('codex --yolo')
  })

  it('threads a model override into the claude agent respawn command', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234', model: 'claude-opus-4-8' })

    const respawn = mockSessionExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    expect(respawn).toBeDefined()
    expect(respawn).toContain('claude --dangerously-skip-permissions --model claude-opus-4-8 --session-id abcd1234')
  })

  it('sets the branch upstream from inside the pod, not on the host', async () => {
    // Host-side writes to the shared /repo/.git/config go stale under the
    // virtiofs cache session pods read through (transient "unknown error
    // occurred while reading the configuration files" in-pod), so tracking
    // is configured by an in-pod exec after worktree creation.
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const cmds = mockSessionExec.mock.calls.map((args) => args[1])
    expect(cmds.some((c) =>
      c.includes("git -C /workspace branch --set-upstream-to 'origin/main'"))).toBe(true)
  })

  it('wires the postStart setup hook and the env that drives it', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    // Base setup (git identity, tmux server + options, streamd) runs in-pod
    // via yaac-session-init — its inputs ride the container env.
    const container = appliedJobManifest().spec.template.spec.containers[0]
    expect(container.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-session-init'] } },
    })
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'YAAC_TOOL', value: 'claude' },
      { name: 'YAAC_GIT_NAME', value: 'Test User' },
      { name: 'YAAC_GIT_EMAIL', value: 'test@example.com' },
      { name: 'YAAC_STATUS_RIGHT', value: ' stub-status ' },
    ]))
    // The gate on the pod's own streamd replaces the old exec chain.
    expect(mockWaitForStreamd).toHaveBeenCalledWith('yaac-demo-abcd1234')
  })

  it('rejects an init window name that collides with any agent tool window', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      // The config parser normally rejects 'claude' as reserved, but the
      // collision guard in validateInitWindows is a belt-and-suspenders
      // backstop — exercise it by feeding a config that bypasses the
      // parser path used in production.
      initCommands: [{ name: 'claude', commands: ['echo hi'] }],
    })
    await expect(createSession('demo', { tool: 'claude' })).rejects.toThrow(
      /collides with an agent tool window/,
    )

    // Other tools' names are rejected too: a retooled spare renames the
    // agent window, so any tool name would make the tmux target ambiguous.
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      initCommands: [{ name: 'codex', commands: ['echo hi'] }],
    })
    await expect(createSession('demo', { tool: 'claude' })).rejects.toThrow(
      /collides with an agent tool window/,
    )
  })

  describe('resume mode', () => {
    it('throws VALIDATION when resume is true but no sessionId is given', async () => {
      await expect(createSession('demo', { resume: true })).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    })

    it('reuses an existing worktree instead of calling addWorktree', async () => {
      mockAccess.mockResolvedValue(undefined)
      const messages: string[] = []
      await createSession('demo', {
        resume: true,
        sessionId: 'abcd1234',
        onProgress: (m) => messages.push(m),
      })
      expect(addWorktree).not.toHaveBeenCalled()
      expect(messages.some((m) => m.includes('Reusing existing worktree'))).toBe(true)
    })

    it('leaves the upstream of a reused worktree untouched', async () => {
      mockAccess.mockResolvedValue(undefined)
      await createSession('demo', { resume: true, sessionId: 'abcd1234' })

      const cmds = mockSessionExec.mock.calls.map((args) => args[1])
      expect(cmds.some((c) => c.includes('--set-upstream-to'))).toBe(false)
    })

    it('still calls addWorktree when the worktree directory is missing', async () => {
      mockAccess.mockImplementation((target) => {
        if (typeof target === 'string' && target.includes('/worktrees/abcd1234')) {
          return Promise.reject(new Error('missing'))
        }
        return Promise.resolve(undefined)
      })
      await createSession('demo', { resume: true, sessionId: 'abcd1234' })
      expect(addWorktree).toHaveBeenCalledTimes(1)
    })
  })

  it('mounts the per-session opencode data dir + shared config dir on every session', async () => {
    // Per-yaac-session opencode data is mounted regardless of which tool
    // is active (matches the existing "claude + codex always mounted"
    // pattern), so the mount shows up here even though tool=claude.
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const { volumes, containers } = appliedJobManifest().spec.template.spec

    const dataVol = volumes.find((v) => v.hostPath?.path === '/tmp/demo/opencode-data/abcd1234')
    expect(dataVol).toBeDefined()
    const dataMount = containers[0].volumeMounts
      .find((m) => m.mountPath === '/home/yaac/.local/share/opencode')
    expect(dataMount?.name).toBe(dataVol?.name)

    const configVol = volumes.find((v) => v.hostPath?.path === '/tmp/demo/opencode-config')
    expect(configVol).toBeDefined()
    const configMount = containers[0].volumeMounts
      .find((m) => m.mountPath === '/home/yaac/.config/opencode')
    expect(configMount?.name).toBe(configVol?.name)

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/demo\/opencode-data\//),
      { recursive: true },
    )
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/opencode-config', { recursive: true })
  })
})

describe('buildAgentCmd', () => {
  it('returns the codex respawn command unchanged', () => {
    const fresh = buildAgentCmd('codex', 'sid-abc', false)
    expect(fresh).toBe('codex --yolo')
    const resume = buildAgentCmd('codex', 'sid-abc', true)
    expect(resume).toBe('codex --yolo resume sid-abc')
  })

  it('returns the claude respawn command unchanged', () => {
    const fresh = buildAgentCmd('claude', 'sid-abc', false)
    expect(fresh).toBe(
      'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id sid-abc',
    )
    const resume = buildAgentCmd('claude', 'sid-abc', true)
    expect(resume).toBe(
      'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume sid-abc',
    )
  })

  it('launches opencode with --port + --hostname so the in-container HTTP server is reachable', () => {
    const fresh = buildAgentCmd('opencode', 'sid-abc', false)
    expect(fresh).toBe('opencode --port 4096 --hostname 127.0.0.1')
  })

  it('passes --continue when resuming an opencode session', () => {
    const resume = buildAgentCmd('opencode', 'sid-abc', true)
    expect(resume).toBe('opencode --port 4096 --hostname 127.0.0.1 --continue')
  })
})

describe('retoolSpare', () => {
  const spare = { jobName: 'yaac-demo-spare1', sessionId: 'spare1', projectSlug: 'demo', tool: 'claude' }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(resolveAllowedHosts).mockReturnValue(['*'])
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.registerSession).mockResolvedValue(undefined)
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('re-registers the proxy session for the new tool, then renames + respawns the agent window', async () => {
    await retoolSpare(spare, 'codex')

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(proxyClient.registerSession).toHaveBeenCalledWith(
      'spare1',
      expect.objectContaining({
        tool: 'codex',
        repoUrl: 'https://github.com/example/repo.git',
        projectSlug: 'demo',
      }),
    )
    const cmds = mockContainerExec.mock.calls.map((c) => c[1])
    expect(cmds.some((c) => c.includes('rename-window -t yaac:claude codex'))).toBe(true)
    const respawn = cmds.find((c) => c.includes('respawn-window'))
    expect(respawn).toContain('-t yaac:codex')
    expect(respawn).toContain('codex --yolo')
  })

  it('boots the new agent with the spare\'s own session id', async () => {
    await retoolSpare({ ...spare, tool: 'codex' }, 'claude')

    const respawn = mockContainerExec.mock.calls.map((c) => c[1]).find((c) => c.includes('respawn-window'))
    expect(respawn).toContain('-t yaac:claude')
    expect(respawn).toContain('--session-id spare1')
  })

  it('propagates registration failures without touching the tmux window', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.registerSession).mockRejectedValue(new Error('proxy down'))
    await expect(retoolSpare(spare, 'codex')).rejects.toThrow('proxy down')
    expect(mockContainerExec).not.toHaveBeenCalled()
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

import type * as allowedHostsModule from '@yaac/server/features/sessions/egress/default-allowed-hosts'
import type * as sharedGitModule from '@yaac/shared/git'
import type * as codexAgentModule from '@yaac/server/features/sessions/agents/codex'
import type * as opencodeAgentModule from '@yaac/server/features/sessions/agents/opencode'
import type * as runtimeModule from '@yaac/server/platform/container/runtime'
import type * as imageBuilderModule from '@yaac/server/features/images/image-builder'
import type * as buildCoordinatorModule from '@yaac/server/features/images/build-coordinator'
import type * as kubectlModule from '@yaac/server/platform/k8s/kubectl'
import type * as execModule from '@yaac/server/platform/k8s/exec'
import type * as portModule from '@yaac/server/platform/container/port'
import type * as projectConfigModule from '@yaac/server/features/projects/config'
import type * as credentialsModule from '@yaac/server/features/projects/credentials'
import type * as gitModule from '@yaac/server/platform/git'
import type * as portForwardersModule from '@yaac/server/features/sessions/forwarders/port-forwarders'

// sessionCreate posts to the streaming /session/create route via the `api`
// singleton; the leaf resolves to a raw streaming Response (the client only
// unwraps JSON routes), which `consumeNdjsonStream` reads.
const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }))
vi.mock('#commands/api', () => ({
  api: { session: { create: { $post: mockPost } } },
}))

import { getGitUserConfig as getGitUserConfigShared } from '@yaac/shared/git'

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

describe('sessionCreate (CLI shim)', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  beforeEach(() => {
    vi.resetAllMocks()
    logSpy.mockClear()

    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(getGitUserConfigShared).mockResolvedValue({ name: 'Test', email: 't@x.io' })
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'progress', message: 'Creating session job yaac-demo-sess-123...' }),
      JSON.stringify({
        type: 'result',
        result: {
          sessionId: 'sess-123',
          jobName: 'yaac-demo-sess-123',
          forwardedPorts: [],
          tool: 'claude',
        },
      }),
    ]))
  })

  it('POSTs /session/create with pre-resolved gitUser and returns the sessionId', async () => {
    const result = await sessionCreate('demo', {})
    expect(result).toBe('sess-123')
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({
        project: 'demo',
        // No --tool → omitted so the server resolves the configured default
        // (and matches the prewarmed spare it keeps for that tool).
        tool: undefined,
        gitUser: { name: 'Test', email: 't@x.io' },
      }) as unknown,
    }))
  })

  it('forwards an explicit --tool unchanged', async () => {
    await sessionCreate('demo', { tool: 'codex' })
    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({ tool: 'codex' }) as unknown,
    }))
  })

  it('prints each progress message from the NDJSON stream', async () => {
    await sessionCreate('demo', {})
    const logged = logSpy.mock.calls.map((args) => args[0] as unknown).filter((v) => typeof v === 'string')
    expect(logged).toContain('Fetching latest from remote...')
    expect(logged).toContain('Creating session job yaac-demo-sess-123...')
  })

  it('throws with the server error message when the stream carries an error event', async () => {
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'error', error: { code: 'VALIDATION', message: 'no github token' } }),
    ]))
    await expect(sessionCreate('demo', {})).rejects.toThrow('no github token')
  })
})
