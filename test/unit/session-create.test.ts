import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '@/daemon/session-create'
import { sessionCreate } from '@/commands/session-create'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
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
  shellPodmanWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  podman: {
    createContainer: vi.fn(),
    getContainer: vi.fn(),
    getImage: vi.fn(),
  },
}))

vi.mock('@/lib/container/image-builder', () => ({
  ensureImage: vi.fn().mockResolvedValue('yaac-test-image'),
  packTar: vi.fn().mockResolvedValue(Buffer.from('archive')),
}))

vi.mock('@/lib/container/proxy-client', () => ({
  proxyClient: {
    containerName: 'yaac-proxy',
    network: 'bridge',
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    registerSession: vi.fn().mockResolvedValue(undefined),
    getProxyEnv: vi.fn().mockReturnValue(['HTTPS_PROXY=http://proxy']),
    getCaCert: vi.fn().mockResolvedValue('cert'),
  },
  buildRulesFromConfig: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/container/default-allowed-hosts', () => ({
  resolveAllowedHosts: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/container/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn().mockReturnValue(vi.fn()),
  podmanRelay: vi.fn().mockReturnValue({}),
}))

vi.mock('@/lib/container/pg-relay', () => ({
  pgRelay: {
    containerPort: 15432,
    ip: '127.0.0.1',
    ensureRunning: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/lib/project/paths', () => ({
  repoDir: vi.fn((slug: string) => `/tmp/${slug}/repo`),
  claudeDir: vi.fn((slug: string) => `/tmp/${slug}/claude`),
  claudeJsonFile: vi.fn((slug: string) => `/tmp/${slug}/claude.json`),
  codexDir: vi.fn((slug: string) => `/tmp/${slug}/codex`),
  cachedPackagesDir: vi.fn((slug: string) => `/tmp/${slug}/.cached-packages`),
  codexTranscriptDir: vi.fn((slug: string) => `/tmp/${slug}/transcripts`),
  worktreeDir: vi.fn((slug: string, sessionId: string) => `/tmp/${slug}/worktrees/${sessionId}`),
  worktreesDir: vi.fn((slug: string) => `/tmp/${slug}/worktrees`),
  projectDir: vi.fn((slug: string) => `/tmp/${slug}`),
  getDataDir: vi.fn(() => '/tmp/yaac-data'),
}))

vi.mock('@/lib/project/config', () => ({
  resolveProjectConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/project/credentials', () => ({
  resolveTokenForUrl: vi.fn().mockResolvedValue('token'),
  loadCredentials: vi.fn().mockResolvedValue({ tokens: [] }),
}))

vi.mock('@/lib/project/tool-auth', () => ({
  loadToolAuthEntry: vi.fn().mockResolvedValue(null),
  loadClaudeCredentialsFile: vi.fn().mockResolvedValue(null),
  writeProjectClaudePlaceholder: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/git', () => ({
  addWorktree: vi.fn().mockResolvedValue(undefined),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
}))

vi.mock('@/shared/git', () => ({
  getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
}))

vi.mock('@/lib/prewarm', () => ({
  claimPrewarmSession: vi.fn(),
}))

vi.mock('@/lib/session/codex-hooks', () => ({
  ensureCodexHooksJson: vi.fn().mockResolvedValue(undefined),
  ensureCodexConfigToml: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/session/port-forwarders', () => ({
  buildStatusRight: vi.fn().mockReturnValue(' stub-status '),
  provisionSessionForwarders: vi.fn().mockResolvedValue([]),
  registerSessionForwarders: vi.fn(),
}))

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { podman, ensureContainerRuntime, shellPodmanWithRetry } from '@/lib/container/runtime'
import { claimPrewarmSession } from '@/lib/prewarm'
import { ensureImage, packTar } from '@/lib/container/image-builder'
import { proxyClient } from '@/lib/container/proxy-client'
import { resolveProjectConfig } from '@/lib/project/config'
import { resolveTokenForUrl, loadCredentials } from '@/lib/project/credentials'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'
import { reserveAvailablePort } from '@/lib/container/port'
import {
  buildStatusRight,
  provisionSessionForwarders,
  registerSessionForwarders,
} from '@/lib/session/port-forwarders'

const mockSpawn = vi.mocked(spawn)
const mockAccess = vi.mocked(fs.access)
const mockMkdir = vi.mocked(fs.mkdir)
const mockWriteFile = vi.mocked(fs.writeFile)
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockCreateContainer = vi.mocked(podman.createContainer)
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockGetContainer = vi.mocked(podman.getContainer)
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockGetImage = vi.mocked(podman.getImage)
const mockClaimPrewarmSession = vi.mocked(claimPrewarmSession)
const mockReserveAvailablePort = vi.mocked(reserveAvailablePort)
const mockProvisionSessionForwarders = vi.mocked(provisionSessionForwarders)
const mockRegisterSessionForwarders = vi.mocked(registerSessionForwarders)
const mockBuildStatusRight = vi.mocked(buildStatusRight)

function mockAttachedChild(): EventEmitter {
  const child = new EventEmitter()
  process.nextTick(() => child.emit('close', 0))
  return child
}

describe('createSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()

    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    vi.mocked(ensureContainerRuntime).mockResolvedValue(undefined)
    vi.mocked(ensureImage).mockResolvedValue('yaac-test-image')
    vi.mocked(packTar).mockResolvedValue(Buffer.from('archive'))
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(resolveTokenForUrl).mockResolvedValue('token')
    vi.mocked(loadCredentials).mockResolvedValue({ tokens: [] })
    vi.mocked(addWorktree).mockResolvedValue(undefined)
    vi.mocked(getDefaultBranch).mockResolvedValue('main')
    vi.mocked(fetchOrigin).mockResolvedValue(undefined)
    vi.mocked(getGitUserConfig).mockResolvedValue({ name: 'Test User', email: 'test@example.com' })
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.ensureRunning).mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.registerSession).mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.getProxyEnv).mockReturnValue(['HTTPS_PROXY=http://proxy'])
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.getCaCert).mockResolvedValue('cert')
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    mockClaimPrewarmSession.mockResolvedValue(null)
    mockReserveAvailablePort.mockResolvedValue({
      containerPort: 3000,
      hostPort: 3000,
      server: { close: vi.fn() },
    } as never)
    mockProvisionSessionForwarders.mockResolvedValue([])
    mockBuildStatusRight.mockReturnValue(' stub-status ')
    mockCreateContainer.mockResolvedValue({
      start: vi.fn().mockResolvedValue(undefined),
    } as never)
    mockGetContainer.mockReturnValue({
      putArchive: vi.fn().mockResolvedValue(undefined),
    } as never)
    mockGetImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Config: { Env: [] } }),
    } as never)
  })

  it('returns the claimed prewarmed session without starting a new container', async () => {
    mockClaimPrewarmSession.mockResolvedValue({
      sessionId: 'prewarm-session',
      containerName: 'yaac-demo-prewarm-session',
    })

    const result = await createSession('demo', {})

    expect(result).toEqual({
      sessionId: 'prewarm-session',
      containerName: 'yaac-demo-prewarm-session',
      forwardedPorts: [],
      tool: 'claude',
      claimedPrewarm: true,
    })
    expect(mockCreateContainer).not.toHaveBeenCalled()
  })

  it('provisions forwarders for claimed prewarm sessions and returns the mappings', async () => {
    mockClaimPrewarmSession.mockResolvedValue({
      sessionId: 'prewarm-session',
      containerName: 'yaac-demo-prewarm-session',
    })
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    mockProvisionSessionForwarders.mockResolvedValue([
      { containerPort: 3000, hostPort: 3000 },
    ])

    const result = await createSession('demo', {})

    expect(mockProvisionSessionForwarders).toHaveBeenCalledTimes(1)
    expect(mockProvisionSessionForwarders).toHaveBeenCalledWith(
      'demo', 'prewarm-session', 'yaac-demo-prewarm-session',
      [{ containerPort: 3000, hostPortStart: 3000 }],
    )
    expect(result?.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3000 }])
    expect(result?.claimedPrewarm).toBe(true)
  })

  it('does not reserve ports when creating a prewarm session', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })

    await createSession('demo', { createPrewarm: true, sessionId: 'new-prewarm' })

    expect(mockReserveAvailablePort).not.toHaveBeenCalled()
    expect(mockRegisterSessionForwarders).not.toHaveBeenCalled()
    expect(mockProvisionSessionForwarders).not.toHaveBeenCalled()
  })

  it('reserves and registers forwarders on a fresh non-prewarm session', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    mockReserveAvailablePort.mockResolvedValueOnce({
      containerPort: 3000,
      hostPort: 3001,
      server: { close: vi.fn() },
    } as never)

    const result = await createSession('demo', {})

    expect(mockReserveAvailablePort).toHaveBeenCalledWith(3000, 3000)
    expect(mockRegisterSessionForwarders).toHaveBeenCalledTimes(1)
    expect(result?.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3001 }])
    expect(result?.claimedPrewarm).toBe(false)
  })

  it('returns a newly created session descriptor without attaching', async () => {
    const result = await createSession('demo', { tool: 'codex' })

    expect(result).toBeDefined()
    expect(result?.sessionId).toEqual(expect.any(String))
    expect(result?.tool).toBe('codex')
    expect(result?.claimedPrewarm).toBe(false)
    expect(mockCreateContainer).toHaveBeenCalledTimes(1)
  })

  it('mounts shared Claude and Codex state for Claude sessions', async () => {
    await createSession('demo', { tool: 'claude' })

    const binds = mockCreateContainer.mock.calls[0]?.[0].HostConfig?.Binds
    expect(binds).toEqual(expect.arrayContaining([
      '/tmp/demo/claude:/home/yaac/.claude:Z',
      '/tmp/demo/claude.json:/home/yaac/.claude.json:Z',
      '/tmp/demo/codex:/home/yaac/.codex:Z',
    ]))
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/claude', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/codex', { recursive: true })
  })

  it('calls onProgress with stage messages during provisioning', async () => {
    const messages: string[] = []
    await createSession('demo', {
      tool: 'claude',
      onProgress: (m) => messages.push(m),
    })
    expect(messages).toContain('Fetching latest from remote...')
    expect(messages).toContain('Ensuring container images are built...')
    expect(messages).toContain('Creating worktree from main...')
    expect(messages).toContain('Starting proxy sidecar...')
    expect(messages.some((m) => m.startsWith('Creating container yaac-demo-'))).toBe(true)
    expect(messages).toContain('Starting Claude Code...')
  })

  it('emits a claim-prewarm message when claiming a prewarmed session', async () => {
    mockClaimPrewarmSession.mockResolvedValue({
      sessionId: 'prewarm-0123456789abcdef',
      containerName: 'yaac-demo-prewarm-0123456789abcdef',
    })
    const messages: string[] = []
    await createSession('demo', { onProgress: (m) => messages.push(m) })
    expect(messages).toEqual([
      'Claiming prewarmed session prewarm-...',
    ])
  })

  it('force-removes the container after every failed startup attempt, including the last', async () => {
    mockCreateContainer.mockResolvedValue({
      start: vi.fn().mockRejectedValue(new Error('container refused to start')),
    } as never)

    await expect(createSession('demo', {})).rejects.toThrow('container refused to start')

    const rmCalls = vi.mocked(shellPodmanWithRetry).mock.calls
      .map((args) => args[0])
      .filter((cmd) => typeof cmd === 'string' && cmd.startsWith('podman rm -f '))
    expect(rmCalls).toHaveLength(3)
    for (const cmd of rmCalls) {
      expect(cmd).toMatch(/^podman rm -f yaac-demo-/)
    }
  })

  it('mounts shared Claude and Codex state for Codex sessions', async () => {
    mockAccess.mockImplementation((target) => {
      if (target === '/tmp/demo/claude.json') {
        return Promise.reject(new Error('missing'))
      }
      return Promise.resolve(undefined)
    })

    await createSession('demo', { tool: 'codex' })

    const binds = mockCreateContainer.mock.calls[0]?.[0].HostConfig?.Binds
    expect(binds).toEqual(expect.arrayContaining([
      '/tmp/demo/claude:/home/yaac/.claude:Z',
      '/tmp/demo/claude.json:/home/yaac/.claude.json:Z',
      '/tmp/demo/codex:/home/yaac/.codex:Z',
    ]))
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/demo/claude.json', '{}')
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/claude', { recursive: true })
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/demo/codex', { recursive: true })
  })
})

import type * as daemonClientModule from '@/shared/daemon-client'

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
      JSON.stringify({ type: 'progress', message: 'Creating container yaac-demo-sess-123...' }),
      JSON.stringify({
        type: 'result',
        result: {
          sessionId: 'sess-123',
          containerName: 'yaac-demo-sess-123',
          forwardedPorts: [],
          tool: 'claude',
          claimedPrewarm: false,
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
        tool: 'claude',
        gitUser: { name: 'Test', email: 't@x.io' },
      }) as unknown,
    }))
  })

  it('prints each progress message from the NDJSON stream', async () => {
    await sessionCreate('demo', {})
    const logged = logSpy.mock.calls.map((args) => args[0] as unknown).filter((v) => typeof v === 'string')
    expect(logged).toContain('Fetching latest from remote...')
    expect(logged).toContain('Creating container yaac-demo-sess-123...')
  })

  it('throws with the daemon error message when the stream carries an error event', async () => {
    mockPost.mockResolvedValue(streamingResponse([
      JSON.stringify({ type: 'progress', message: 'Fetching latest from remote...' }),
      JSON.stringify({ type: 'error', error: { code: 'VALIDATION', message: 'no github token' } }),
    ]))
    await expect(sessionCreate('demo', {})).rejects.toThrow('no github token')
  })
})
