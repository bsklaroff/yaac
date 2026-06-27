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
  },
}))

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    remote: vi.fn().mockResolvedValue('https://github.com/example/repo.git'),
    addConfig: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/lib/container/runtime', () => ({
  ensureContainerRuntime: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/container/image-builder', () => ({
  ensureImage: vi.fn().mockResolvedValue('yaac-test-image'),
}))

vi.mock('@/lib/k8s/registry', () => ({
  pushImageToRegistry: vi.fn().mockResolvedValue('localhost:5000/yaac-test-image'),
}))

vi.mock('@/lib/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/k8s/exec', () => ({
  containerExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/container/proxy-client', () => ({
  PROXY_CONTAINER_PORT: '10255',
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
}))

vi.mock('@/lib/container/default-allowed-hosts', async (importOriginal) => {
  const actual = await importOriginal<typeof allowedHostsModule>()
  return {
    ...actual,
    // Default to '*' so session-create's allowlist hard-check passes.
    // Tests that need a specific allowlist can override per-test.
    resolveAllowedHosts: vi.fn().mockReturnValue(['*']),
  }
})

vi.mock('@/lib/container/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn().mockReturnValue(vi.fn()),
  kubectlRelay: vi.fn().mockReturnValue(() => ({})),
}))

vi.mock('@/lib/project/paths', () => ({
  repoDir: vi.fn((slug: string) => `/tmp/${slug}/repo`),
  claudeDir: vi.fn((slug: string) => `/tmp/${slug}/claude`),
  claudeJsonFile: vi.fn((slug: string) => `/tmp/${slug}/claude.json`),
  codexDir: vi.fn((slug: string) => `/tmp/${slug}/codex`),
  opencodeConfigDir: vi.fn((slug: string) => `/tmp/${slug}/opencode-config`),
  opencodeDataDir: vi.fn((slug: string, sessionId: string) => `/tmp/${slug}/opencode-data/${sessionId}`),
  opencodeMetaDir: vi.fn((slug: string) => `/tmp/${slug}/opencode-meta`),
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

vi.mock('@/lib/project/config', () => ({
  resolveProjectConfig: vi.fn().mockResolvedValue({}),
  resolveEphemeralModulesPaths: () => [],
  ephemeralModulesSlotKey: (p: string) => (p === 'node_modules' ? 'root' : p.replace(/\//g, '_')),
}))

vi.mock('@/lib/project/credentials', () => ({
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
  ghApiHostForGitHost: (host: string) => (host === 'github.com' ? 'api.github.com' : null),
  writeProxySecrets: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/project/tool-auth', () => ({
  loadToolAuthEntry: vi.fn().mockResolvedValue(null),
  loadClaudeCredentialsFile: vi.fn().mockResolvedValue(null),
  loadCodexCredentialsFile: vi.fn().mockResolvedValue(null),
  writeProjectClaudePlaceholder: vi.fn().mockResolvedValue(undefined),
  writeProjectCodexPlaceholder: vi.fn().mockResolvedValue(undefined),
  PLACEHOLDER_API_KEY: 'test-placeholder-key',
  PLACEHOLDER_GH_TOKEN: 'test-placeholder-gh-token',
}))

vi.mock('@/lib/git', () => ({
  addWorktree: vi.fn().mockResolvedValue(undefined),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
  writeKnownHostsFile: vi.fn().mockResolvedValue(undefined),
  isTorEnabled: vi.fn().mockReturnValue(false),
}))

vi.mock('@/shared/git', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGitModule>()
  return {
    ...actual,
    getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
  }
})

vi.mock('@/lib/session/codex-hooks', () => ({
  ensureCodexHooksJson: vi.fn().mockResolvedValue(undefined),
  ensureCodexConfigToml: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/session/opencode-config', () => ({
  ensureOpencodeConfigJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/session/port-forwarders', () => ({
  buildStatusRight: vi.fn().mockReturnValue(' stub-status '),
  registerSessionForwarders: vi.fn(),
}))

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { buildAgentCmd, createSession, resolveInitWindows } from '@/daemon/session-create'
import { sessionCreate } from '@/commands/session-create'
import { ensureContainerRuntime } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { pushImageToRegistry } from '@/lib/k8s/registry'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { containerExec } from '@/lib/k8s/exec'
import { clusterIpForNamespace } from '@/lib/k8s/bootstrap'
import { proxyClient } from '@/lib/container/proxy-client'
import { resolveProjectConfig } from '@/lib/project/config'
import simpleGit from 'simple-git'
import { resolveCredentialForUrl, loadKnownHostsEntryForHost } from '@/lib/project/credentials'
import { loadToolAuthEntry } from '@/lib/project/tool-auth'
import { resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'
import { kubectlRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import { buildStatusRight, registerSessionForwarders } from '@/lib/session/port-forwarders'

const mockSpawn = vi.mocked(spawn)
const mockAccess = vi.mocked(fs.access)
const mockMkdir = vi.mocked(fs.mkdir)
const mockWriteFile = vi.mocked(fs.writeFile)
const mockReadFile = vi.mocked(fs.readFile)
const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockKubectlRetry = vi.mocked(kubectlWithRetry)
const mockContainerExec = vi.mocked(containerExec)
const mockReserveAvailablePort = vi.mocked(reserveAvailablePort)
const mockStartForwarders = vi.mocked(startPortForwarders)
const mockKubectlRelay = vi.mocked(kubectlRelay)
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
    vi.mocked(ensureContainerRuntime).mockResolvedValue(undefined)
    vi.mocked(ensureImage).mockResolvedValue('yaac-test-image')
    vi.mocked(pushImageToRegistry).mockResolvedValue('localhost:5000/yaac-test-image')
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(resolveCredentialForUrl).mockResolvedValue({ kind: 'https', token: 'token' } as never)
    vi.mocked(resolveAllowedHosts).mockReturnValue(['*'])
    vi.mocked(addWorktree).mockResolvedValue(undefined)
    vi.mocked(getDefaultBranch).mockResolvedValue('main')
    vi.mocked(fetchOrigin).mockResolvedValue(undefined)
    vi.mocked(getGitUserConfig).mockResolvedValue({ name: 'Test User', email: 'test@example.com' })
    mockLoadToolAuth.mockResolvedValue(null)
    /* eslint-disable @typescript-eslint/unbound-method */
    vi.mocked(proxyClient.ensureRunning).mockResolvedValue(undefined)
    vi.mocked(proxyClient.registerSession).mockResolvedValue(undefined)
    vi.mocked(proxyClient.getCaTrustEnv).mockReturnValue(['SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem'])
    /* eslint-enable @typescript-eslint/unbound-method */
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockApply.mockResolvedValue(undefined)
    // waitForPodReady polls this — default to "pod ready" so the flow runs
    // straight through. Failure tests override it.
    mockGetJson.mockResolvedValue({
      items: [{
        status: { phase: 'Running', containerStatuses: [{ ready: true }] },
      }],
    })
    mockKubectlRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockStartForwarders.mockReturnValue(vi.fn())
    mockKubectlRelay.mockReturnValue((() => ({})) as never)
    vi.mocked(buildStatusRight).mockReturnValue(' stub-status ')
    mockReserveAvailablePort.mockResolvedValue({
      containerPort: 3000,
      hostPort: 3000,
      server: { close: vi.fn() },
    } as never)
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

  it('seeds OPENROUTER_API_KEY for an opencode session on the openrouter provider', async () => {
    mockLoadToolAuth.mockResolvedValue({
      tool: 'opencode',
      kind: 'api-key',
      apiKey: 'sk-or-real',
      savedAt: new Date().toISOString(),
      opencodeProvider: 'openrouter',
    })
    await createSession('demo', { tool: 'opencode', sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'OPENROUTER_API_KEY', value: 'test-placeholder-key' })
    expect(env.map((e) => e.name)).not.toContain('NEURALWATT_API_KEY')
  })

  it('seeds NEURALWATT_API_KEY for an opencode session on the neuralwatt provider', async () => {
    mockLoadToolAuth.mockResolvedValue({
      tool: 'opencode',
      kind: 'api-key',
      apiKey: 'nw-real',
      savedAt: new Date().toISOString(),
      opencodeProvider: 'neuralwatt',
    })
    await createSession('demo', { tool: 'opencode', sessionId: 'abcd1234' })

    const env = appliedJobManifest().spec.template.spec.containers[0].env
    expect(env).toContainEqual({ name: 'NEURALWATT_API_KEY', value: 'test-placeholder-key' })
    expect(env.map((e) => e.name)).not.toContain('OPENROUTER_API_KEY')
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
      '/tmp/demo/.cached-packages',
      '/tmp/demo/sessions/abcd1234/tmux',
    ]))
    // ~/.claude.json is a single file — hostPath type File.
    const claudeJsonVol = manifest.spec.template.spec.volumes
      .find((v) => v.hostPath?.path === '/tmp/demo/claude.json')
    expect(claudeJsonVol?.hostPath?.type).toBe('File')

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/claude', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/codex', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/opencode-meta', { recursive: true })
  })

  it('injects no per-pod egress sidecars and points the pod resolver at the proxy VIP', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const spec = appliedJobManifest().spec.template.spec
    // Egress is redirected at the cluster level (Cilium CEC + CNP) — the Job
    // carries no redirect-init/relay init containers.
    expect(spec.initContainers).toBeUndefined()
    // The pod resolves DNS against the proxy VIP's stub (pinned, never a DNS
    // name); identity is the source pod IP the proxy watches, so no token.
    expect(spec.dnsPolicy).toBe('None')
    expect(spec.dnsConfig).toEqual({ nameservers: [clusterIpForNamespace('yaac')] })
    const sessionEnvNames = spec.containers[0].env.map((e: { name: string }) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
    // No bind endpoint exists — identity is stateless at the proxy.
    expect(proxyClient).not.toHaveProperty('relayToken')
  })

  it('routes SSH through the Cilium-redirected tunnel sentinel with no credential', async () => {
    // SSH-scheme remote: ncat CONNECTs to the sentinel address that Cilium
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

  it('mounts --add-dir read-only and --add-dir-rw read-write with the no-check hostPath type', async () => {
    await createSession('demo', { sessionId: 'abcd1234', addDir: ['/host/extra'], addDirRw: ['/host/rw'] })

    const manifest = appliedJobManifest()
    const { volumes, containers } = manifest.spec.template.spec

    const roVol = volumes.find((v) => v.hostPath?.path === '/host/extra')
    expect(roVol?.hostPath?.type).toBe('')
    const roMount = containers[0].volumeMounts.find((m) => m.mountPath === '/add-dir/host/extra')
    expect(roMount?.readOnly).toBe(true)
    expect(roMount?.name).toBe(roVol?.name)

    const rwVol = volumes.find((v) => v.hostPath?.path === '/host/rw')
    expect(rwVol?.hostPath?.type).toBe('')
    const rwMount = containers[0].volumeMounts.find((m) => m.mountPath === '/add-dir/host/rw')
    expect(rwMount?.readOnly).toBeUndefined()
  })

  it('adds the placeholder API key env for claude api-key auth', async () => {
    mockLoadToolAuth.mockResolvedValue({ kind: 'api-key' } as never)

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

  it('never chowns mounts in-container — uid alignment makes daemon dirs writable', async () => {
    await createSession('demo', { sessionId: 'abcd1234' })

    // The image's yaac user carries the daemon's uid (YAAC_UID build arg),
    // so daemon-created hostPath dirs are writable without privileged
    // fixups. A chown here would also corrupt host-side ownership on
    // Linux (idmapped mounts write the pod's userns uid through).
    const cmds = mockContainerExec.mock.calls.map((c) => c[1])
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
    mockKubectlRelay.mockReturnValue(relayFactory)

    const result = await createSession('demo', { sessionId: 'abcd1234' })

    expect(mockReserveAvailablePort).toHaveBeenCalledWith(3000, 3000)
    expect(mockKubectlRelay).toHaveBeenCalledWith('yaac-demo-abcd1234')
    expect(mockStartForwarders).toHaveBeenCalledWith(relayFactory, [reserved])
    expect(mockRegisterSessionForwarders).toHaveBeenCalledWith('abcd1234', expect.any(Function))
    expect(result?.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3001 }])
  })

  it('deletes the half-created Job after every failed startup attempt, including the last', async () => {
    // waitForPodReady sees a terminal pod on every attempt.
    mockGetJson.mockResolvedValue({ items: [{ status: { phase: 'Failed' } }] })

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

  it('seeds claude.json without onboarding flags for non-Claude sessions', async () => {
    await createSession('demo', { tool: 'codex', sessionId: 'abcd1234' })
    // seedClaudeJson ensures the file exists (pretty JSON + trailing
    // newline). No onboarding flags for a non-Claude (codex) session.
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/demo/claude.json', '{}\n')
  })

  it('spawns one tmux new-window per InitCommandSpec entry', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'frontend', commands: ['pnpm dev:frontend'], hidePane: true },
      ],
    })

    await createSession('demo', { tool: 'claude' })

    const tmuxCmds = mockContainerExec.mock.calls
      .map((args) => args[1])
      .filter((c) => c.includes('new-window'))
    expect(tmuxCmds.some((c) => c.includes('-n backend') && c.includes('pnpm dev:backend'))).toBe(true)
    expect(tmuxCmds.some((c) => c.includes('-n frontend') && c.includes('pnpm dev:frontend'))).toBe(true)

    const remainOnExitCmds = mockContainerExec.mock.calls
      .map((args) => args[1])
      .filter((c) => c.includes('remain-on-exit on'))
    // backend defaults to hidePane=false → keeps remain-on-exit; frontend
    // sets hidePane=true → no remain-on-exit.
    expect(remainOnExitCmds.some((c) => c.includes('yaac:backend'))).toBe(true)
    expect(remainOnExitCmds.some((c) => c.includes('yaac:frontend'))).toBe(false)
  })

  it('respawns the agent window with the tool command after tmux setup', async () => {
    await createSession('demo', { tool: 'codex', sessionId: 'abcd1234' })

    const respawn = mockContainerExec.mock.calls
      .map((args) => args[1])
      .find((c) => c.includes('respawn-window'))
    expect(respawn).toBeDefined()
    expect(respawn).toContain('-t yaac:codex')
    expect(respawn).toContain('codex --yolo')
  })

  it('configures tmux for truecolor (RGB) passthrough to the attached terminal', async () => {
    await createSession('demo', { tool: 'claude', sessionId: 'abcd1234' })

    const cmds = mockContainerExec.mock.calls.map((args) => args[1])
    // The `*` glob in the feature value stays single-quoted so the host
    // shell in containerExec passes it literally instead of expanding it.
    expect(cmds.some((c) => c.includes("set-option -as terminal-features ',*:RGB'"))).toBe(true)
    expect(cmds.some((c) => c.includes('set-option -g default-terminal tmux-256color'))).toBe(true)
  })

  it('rejects an init window name that collides with the agent tool window', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      // The config parser normally rejects 'claude' as reserved, but the
      // collision guard inside startJobWithSetup is a belt-and-suspenders
      // backstop — exercise it by feeding a config that bypasses the
      // parser path used in production.
      initCommands: [{ name: 'claude', commands: ['echo hi'] }],
    })
    await expect(createSession('demo', { tool: 'claude' })).rejects.toThrow(
      /collides with the agent window for tool "claude"/,
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
    const fresh = buildAgentCmd('codex', 'sid-abc', '--add-dir /add-dir/x', false)
    expect(fresh).toBe('codex --yolo --add-dir /add-dir/x')
    const resume = buildAgentCmd('codex', 'sid-abc', '', true)
    expect(resume).toBe('codex --yolo resume sid-abc')
  })

  it('returns the claude respawn command unchanged', () => {
    const fresh = buildAgentCmd('claude', 'sid-abc', '', false)
    expect(fresh).toBe(
      'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id sid-abc',
    )
    const resume = buildAgentCmd('claude', 'sid-abc', '', true)
    expect(resume).toBe(
      'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume sid-abc',
    )
  })

  it('launches opencode with --port + --hostname so the in-container HTTP server is reachable', () => {
    const fresh = buildAgentCmd('opencode', 'sid-abc', '', false)
    expect(fresh).toBe('opencode --port 4096 --hostname 127.0.0.1')
  })

  it('passes --continue when resuming an opencode session', () => {
    const resume = buildAgentCmd('opencode', 'sid-abc', '', true)
    expect(resume).toBe('opencode --port 4096 --hostname 127.0.0.1 --continue')
  })

  it('drops add-dir flags for opencode (no CLI equivalent in opencode)', () => {
    const cmd = buildAgentCmd('opencode', 'sid-abc', '--add-dir /add-dir/x', false)
    expect(cmd).toBe('opencode --port 4096 --hostname 127.0.0.1')
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

import type * as daemonClientModule from '@/shared/daemon-client'
import type * as allowedHostsModule from '@/lib/container/default-allowed-hosts'
import type * as sharedGitModule from '@/shared/git'

vi.mock('@/shared/daemon-client', async (importOriginal) => {
  const actual = await importOriginal<typeof daemonClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
  }
})

import { getRpcClient } from '@/shared/daemon-client'
import { getGitUserConfig as getGitUserConfigShared } from '@/shared/git'

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
  const mockPost = vi.fn()
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
    vi.mocked(getRpcClient).mockResolvedValue({
      session: {
        create: { $post: mockPost },
      },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
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
        // No --tool → omitted so the daemon resolves the configured default
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

  it('throws with the daemon error message when the stream carries an error event', async () => {
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'error', error: { code: 'VALIDATION', message: 'no github token' } }),
    ]))
    await expect(sessionCreate('demo', {})).rejects.toThrow('no github token')
  })
})
