import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import * as runtime from '@/lib/container/runtime'
import * as cleanup from '@/lib/session/cleanup'
import * as sessionCreate from '@/daemon/session-create'
import { resolveRestartTarget, restartSession } from '@/lib/session/restart'
import { sessionRestart } from '@/commands/session-restart'
import {
  claudeDir,
  codexTranscriptDir,
  getDataDir,
  worktreesDir,
  projectDir,
} from '@/lib/project/paths'

/**
 * Unit coverage for the session-restart pipeline: target resolution
 * (live container first, filesystem fallback for reaped sessions) and
 * the handoff to `cleanupSession` + `createSession(resume: true)`.
 * Podman / createSession are mocked so we don't need a running podman.
 */
describe('resolveRestartTarget', () => {
  type PodmanContainerInspect = {
    Id: string
    Names?: string[]
    Labels?: Record<string, string>
    State?: string
  }

  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<(opts?: unknown) => Promise<PodmanContainerInspect[]>>>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    vi.spyOn(runtime.podman, 'listContainers').mockImplementation(
      listSpy as unknown as typeof runtime.podman.listContainers,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTempDir(tmpDir)
  })

  function container(overrides: Partial<PodmanContainerInspect> = {}): PodmanContainerInspect {
    return {
      Id: 'fullcontainerid00000000',
      Names: ['/yaac-demo-abcd1234'],
      Labels: {
        'yaac.data-dir': getDataDir(),
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
        'yaac.tool': 'claude',
      },
      State: 'running',
      ...overrides,
    }
  }

  it('resolves from a live container by exact session id', async () => {
    listSpy.mockResolvedValueOnce([container()])
    const info = await resolveRestartTarget('abcd1234')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'abcd1234',
      tool: 'claude',
      containerName: 'yaac-demo-abcd1234',
    })
  })

  it('resolves tool=codex from the container label', async () => {
    listSpy.mockResolvedValueOnce([container({
      Labels: {
        'yaac.data-dir': getDataDir(),
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
        'yaac.tool': 'codex',
      },
    })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('codex')
  })

  it('resolves from a live container by session id prefix', async () => {
    listSpy.mockResolvedValueOnce([container()])
    const info = await resolveRestartTarget('abcd')
    expect(info.sessionId).toBe('abcd1234')
    expect(info.containerName).toBe('yaac-demo-abcd1234')
  })

  it('falls back to the worktree dir + claude transcript for a reaped session', async () => {
    listSpy.mockResolvedValueOnce([])
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(path.join(worktreesDir('demo'), 'deadbeefdeadbeef'), { recursive: true })
    await fs.mkdir(path.join(claudeDir('demo'), 'projects', '-workspace'), { recursive: true })
    await fs.writeFile(
      path.join(claudeDir('demo'), 'projects', '-workspace', 'deadbeefdeadbeef.jsonl'),
      '',
    )
    const info = await resolveRestartTarget('deadbeefdeadbeef')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'deadbeefdeadbeef',
      tool: 'claude',
      containerName: null,
    })
  })

  it('detects tool=codex from the transcript file when no claude jsonl exists', async () => {
    listSpy.mockResolvedValueOnce([])
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(path.join(worktreesDir('demo'), 'codexsess'), { recursive: true })
    await fs.mkdir(codexTranscriptDir('demo'), { recursive: true })
    await fs.writeFile(path.join(codexTranscriptDir('demo'), 'codexsess.jsonl'), '')
    const info = await resolveRestartTarget('codexsess')
    expect(info.tool).toBe('codex')
    expect(info.containerName).toBeNull()
  })

  it('resolves a worktree-dir prefix match across projects', async () => {
    listSpy.mockResolvedValueOnce([])
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(path.join(worktreesDir('demo'), 'abcd1234ffff'), { recursive: true })
    const info = await resolveRestartTarget('abcd')
    expect(info.sessionId).toBe('abcd1234ffff')
    expect(info.projectSlug).toBe('demo')
  })

  it('throws NOT_FOUND when no container and no worktree match', async () => {
    listSpy.mockResolvedValueOnce([])
    await expect(resolveRestartTarget('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('falls through to the filesystem when podman is unavailable', async () => {
    listSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(path.join(worktreesDir('demo'), 'xyz'), { recursive: true })
    const info = await resolveRestartTarget('xyz')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'xyz',
      tool: 'claude',
      containerName: null,
    })
  })
})

describe('restartSession', () => {
  type PodmanContainerInspect = {
    Id: string
    Names?: string[]
    Labels?: Record<string, string>
    State?: string
  }

  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<(opts?: unknown) => Promise<PodmanContainerInspect[]>>>
  let cleanupSpy: ReturnType<typeof vi.fn>
  let createSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    cleanupSpy = vi.fn().mockResolvedValue(undefined)
    createSpy = vi.fn().mockResolvedValue({
      sessionId: 'abcd1234',
      containerName: 'yaac-demo-abcd1234',
      forwardedPorts: [],
      tool: 'claude',
      claimedPrewarm: false,
    })
    vi.spyOn(runtime.podman, 'listContainers').mockImplementation(
      listSpy as unknown as typeof runtime.podman.listContainers,
    )
    vi.spyOn(cleanup, 'cleanupSession').mockImplementation(
      cleanupSpy as unknown as typeof cleanup.cleanupSession,
    )
    vi.spyOn(sessionCreate, 'createSession').mockImplementation(
      createSpy as unknown as typeof sessionCreate.createSession,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTempDir(tmpDir)
  })

  it('kills the live container first, then creates a resumed session', async () => {
    listSpy.mockResolvedValueOnce([{
      Id: 'full',
      Names: ['/yaac-demo-abcd1234'],
      Labels: {
        'yaac.data-dir': getDataDir(),
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
        'yaac.tool': 'claude',
      },
      State: 'running',
    }])

    const progress: string[] = []
    await restartSession('abcd1234', { onProgress: (m) => progress.push(m) })

    expect(cleanupSpy).toHaveBeenCalledWith({
      containerName: 'yaac-demo-abcd1234',
      projectSlug: 'demo',
      sessionId: 'abcd1234',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      sessionId: 'abcd1234',
      tool: 'claude',
    }))
    expect(progress.some((m) => m.includes('Stopping container yaac-demo-abcd1234'))).toBe(true)
  })

  it('skips cleanup when no container exists and falls back to the worktree', async () => {
    listSpy.mockResolvedValueOnce([])
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(path.join(worktreesDir('demo'), 'deadbeef'), { recursive: true })

    await restartSession('deadbeef')

    expect(cleanupSpy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      sessionId: 'deadbeef',
      tool: 'claude',
    }))
  })

  it('forwards addDir / addDirRw / gitUser into createSession', async () => {
    listSpy.mockResolvedValueOnce([{
      Id: 'full',
      Names: ['/yaac-demo-abcd1234'],
      Labels: {
        'yaac.data-dir': getDataDir(),
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
        'yaac.tool': 'claude',
      },
      State: 'running',
    }])

    await restartSession('abcd1234', {
      addDir: ['/tmp/ro'],
      addDirRw: ['/tmp/rw'],
      gitUser: { name: 'A', email: 'a@b' },
    })

    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      addDir: ['/tmp/ro'],
      addDirRw: ['/tmp/rw'],
      gitUser: { name: 'A', email: 'a@b' },
    }))
  })
})

describe('sessionRestart (CLI shim)', () => {
  it('is exported as a function', () => {
    expect(typeof sessionRestart).toBe('function')
  })

  it('rejects a relative --add-dir path without hitting the daemon', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* noop */ })
    const prevExitCode = process.exitCode
    process.exitCode = 0
    try {
      await sessionRestart('sess-x', { addDir: ['relative/path'] })
      expect(process.exitCode).toBe(1)
      expect(errorSpy).toHaveBeenCalled()
      const msg = (errorSpy.mock.calls[0]?.[0] as string | undefined) ?? ''
      expect(msg).toMatch(/absolute/i)
    } finally {
      errorSpy.mockRestore()
      process.exitCode = prevExitCode
    }
  })
})
