import { EventEmitter } from 'node:events'
import type { Server } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, sessionCreate } from '@/commands/session-create'

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
  execPodmanWithRetry: vi.fn(),
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

vi.mock('@/lib/prewarm', () => ({
  claimPrewarmSession: vi.fn(),
}))

vi.mock('@/lib/session/codex-hooks', () => ({
  ensureCodexHooksJson: vi.fn().mockResolvedValue(undefined),
  ensureCodexConfigToml: vi.fn().mockResolvedValue(undefined),
}))

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { podman, ensureContainerRuntime } from '@/lib/container/runtime'
import { claimPrewarmSession } from '@/lib/prewarm'
import { ensureImage, packTar } from '@/lib/container/image-builder'
import { proxyClient } from '@/lib/container/proxy-client'
import { resolveProjectConfig } from '@/lib/project/config'
import { resolveTokenForUrl, loadCredentials } from '@/lib/project/credentials'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'

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

import type * as daemonClientModule from '@/lib/daemon-client'

vi.mock('@/lib/daemon-client', async (importOriginal) => {
  const actual = await importOriginal<typeof daemonClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
  }
})

import { getRpcClient } from '@/lib/daemon-client'
import { startPortForwarders, reserveAvailablePort } from '@/lib/container/port'

describe('sessionCreate (CLI shim)', () => {
  const mockPost = vi.fn()
  const mockReserveAvailablePort = vi.mocked(reserveAvailablePort)
  const mockStartPortForwarders = vi.mocked(startPortForwarders)

  beforeEach(() => {
    vi.resetAllMocks()

    mockAccess.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    vi.mocked(resolveProjectConfig).mockResolvedValue({})
    vi.mocked(getGitUserConfig).mockResolvedValue({ name: 'Test', email: 't@x.io' })
    mockStartPortForwarders.mockReturnValue(vi.fn())
    mockSpawn.mockImplementation(() => mockAttachedChild() as never)
    vi.mocked(getRpcClient).mockResolvedValue({
      session: {
        create: { $post: mockPost },
      },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
    mockPost.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        sessionId: 'sess-123',
        containerName: 'yaac-demo-sess-123',
        forwardedPorts: [],
        tool: 'claude',
        claimedPrewarm: false,
      }),
    })
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

  it('reserves host ports locally and passes them to the daemon', async () => {
    vi.mocked(resolveProjectConfig).mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    mockReserveAvailablePort.mockResolvedValue({
      containerPort: 3000,
      hostPort: 3042,
      server: { close: vi.fn() } as unknown as Server,
    })

    await sessionCreate('demo', {})

    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({
        portReservations: [{ containerPort: 3000, hostPort: 3042 }],
      }) as unknown,
    }))
    expect(mockStartPortForwarders).toHaveBeenCalledTimes(1)
  })
})
