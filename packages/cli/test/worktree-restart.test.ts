import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The CLI shim's own collaborators. Only the `worktreeRestart` describe below
// uses these; the pipeline describes drive the server modules directly.
// Hoisted with the vi.mock calls, which run before any import.
const { attachSpy, postSpy, consumeSpy } = vi.hoisted(() => ({
  attachSpy: vi.fn().mockResolvedValue(undefined),
  postSpy: vi.fn().mockResolvedValue({}),
  consumeSpy: vi.fn(),
}))
vi.mock('#commands/ws-terminal', () => ({ attachWorktreePty: attachSpy }))
vi.mock('#commands/git-identity', () => ({
  ensureGitIdentity: vi.fn().mockResolvedValue({ name: 'T', email: 't@e' }),
}))
vi.mock('#commands/api', () => ({ api: { worktree: { restart: { $post: postSpy } } } }))
vi.mock('@yaac/shared/ndjson', () => ({ consumeNdjsonStream: consumeSpy }))
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import * as pods from '@yaac/server/platform/k8s/pods'
import * as cleanup from '@yaac/server/domain/worktrees/cleanup'
import * as worktreeCreate from '@yaac/server/domain/worktrees/create'
import { resolveRestartTarget, restartWorktree } from '@yaac/server/domain/worktrees/restart'
import { recordWorktreeCreated } from '@yaac/server/records/worktree-store'
import { recordAgentSessions } from '@yaac/server/records/agent-session-store'
import { closeDb } from '@yaac/server/platform/db/client'
import { worktreeRestart } from '#commands/worktree-restart'

import type { PodInfo } from '@yaac/server/platform/k8s/pods'

/**
 * Unit coverage for the session-restart pipeline: target resolution
 * (live workspace first, recorded row for reaped ones) and the handoff to
 * the herd's teardown + create. The real in-process herd stands behind the
 * boundary so the whole pipeline runs; only its substrate leaves are mocked,
 * so we don't need a cluster.
 */
function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: 'yaac-demo-abcd1234',
    podName: 'yaac-demo-abcd1234-p0d42',
    worktreeId: 'abcd1234',
    projectSlug: 'demo',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...overrides,
  }
}

describe('resolveRestartTarget', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<PodInfo[]>>>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    vi.spyOn(pods, 'listWorktreePods').mockImplementation(
      listSpy as unknown as typeof pods.listWorktreePods,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('resolves from a live pod by exact session id', async () => {
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd1234')
    expect(info).toEqual({
      projectSlug: 'demo',
      worktreeId: 'abcd1234',
      tool: 'claude',
      jobName: 'yaac-demo-abcd1234',
    })
  })

  it('resolves tool=codex from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'codex' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('codex')
  })

  it('resolves tool=opencode from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'opencode' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('opencode')
  })

  it('resolves from a live pod by session id prefix', async () => {
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd')
    expect(info.worktreeId).toBe('abcd1234')
    expect(info.jobName).toBe('yaac-demo-abcd1234')
  })

  it('falls back to the recorded session row for a reaped session', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'deadbeefdeadbeef' })
    const info = await resolveRestartTarget('deadbeefdeadbeef')
    expect(info).toEqual({
      projectSlug: 'demo',
      worktreeId: 'deadbeefdeadbeef',
      tool: 'claude',
      jobName: null,
    })
  })

  it('takes the tool from the row, for a tool that leaves no transcript', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'ocsess' })
    // The tool comes from the worktree's first conversation, which create
    // records alongside the row — a worktree has no tool of its own.
    await recordAgentSessions('demo', 'ocsess', [
      { tool: 'opencode', agentSessionId: 'ocsess' },
    ])
    const info = await resolveRestartTarget('ocsess')
    expect(info.tool).toBe('opencode')
    expect(info.jobName).toBeNull()
  })

  it('resolves a recorded session by id prefix, across projects', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'abcd1234ffff' })
    const info = await resolveRestartTarget('abcd')
    expect(info.worktreeId).toBe('abcd1234ffff')
    expect(info.projectSlug).toBe('demo')
  })

  it('throws NOT_FOUND when no pod and no recorded session match', async () => {
    listSpy.mockResolvedValueOnce([])
    await expect(resolveRestartTarget('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('falls through to the recorded row when the cluster is unavailable', async () => {
    listSpy.mockRejectedValueOnce(new Error('connection refused'))
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'xyz' })
    const info = await resolveRestartTarget('xyz')
    expect(info).toEqual({
      projectSlug: 'demo',
      worktreeId: 'xyz',
      tool: 'claude',
      jobName: null,
    })
  })
})

describe('restartWorktree', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<PodInfo[]>>>
  let cleanupSpy: ReturnType<typeof vi.fn>
  let createSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    cleanupSpy = vi.fn().mockResolvedValue(undefined)
    createSpy = vi.fn().mockResolvedValue({
      worktreeId: 'abcd1234',
      jobName: 'yaac-demo-abcd1234',
      forwardedPorts: [],
      tool: 'claude',
    })
    vi.spyOn(pods, 'listWorktreePods').mockImplementation(
      listSpy as unknown as typeof pods.listWorktreePods,
    )
    vi.spyOn(cleanup, 'teardownForRestart').mockImplementation(
      cleanupSpy as unknown as typeof cleanup.teardownForRestart,
    )
    vi.spyOn(worktreeCreate, 'createWorktree').mockImplementation(
      createSpy as unknown as typeof worktreeCreate.createWorktree,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('kills the live job first, then creates a resumed session', async () => {
    listSpy.mockResolvedValueOnce([pod()])

    const progress: string[] = []
    await restartWorktree('abcd1234', { onProgress: (m) => progress.push(m) })

    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: 'yaac-demo-abcd1234',
      projectSlug: 'demo',
      workspaceId: 'abcd1234',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      worktreeId: 'abcd1234',
      tool: 'claude',
      // Nothing was recorded as active, so there is nothing to resume by id —
      // the worktree comes back with one fresh conversation.
      resumeAgentSessions: [],
    }))
    expect(progress.some((m) => m.includes('Stopping session job yaac-demo-abcd1234'))).toBe(true)
  })

  it('has nothing to tear down when no pod exists, and falls back to the recorded row', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'deadbeef' })

    await restartWorktree('deadbeef')

    // Still one teardown call, with no Job to delete: the reuse-blocking
    // marks have to be cleared either way or the fresh session renders as
    // "stopping…".
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: null, projectSlug: 'demo', workspaceId: 'deadbeef',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      worktreeId: 'deadbeef',
      tool: 'claude',
    }))
  })

  it('forwards gitUser into createWorktree', async () => {
    listSpy.mockResolvedValueOnce([pod()])

    await restartWorktree('abcd1234', {
      gitUser: { name: 'A', email: 'a@b' },
    })

    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      gitUser: { name: 'A', email: 'a@b' },
    }))
  })
})

describe('worktreeRestart (CLI shim)', () => {
  beforeEach(() => {
    attachSpy.mockClear()
    postSpy.mockClear()
  })

  it('attaches a terminal to a restarted tui worktree', async () => {
    consumeSpy.mockResolvedValueOnce({ worktreeId: 'w1', jobName: 'j1', mode: 'tui' })
    await expect(worktreeRestart('w1')).resolves.toBe('w1')
    expect(attachSpy).toHaveBeenCalledWith('w1', 'native')
  })

  it('does not attach a terminal to a restarted acp worktree', async () => {
    // An ACP worktree's agent window runs acpd, so attaching drops the user
    // into the supervisor's stdio and sits there — create already refuses for
    // this reason, and a restart has to refuse identically or the CLI hangs
    // until the attach times out.
    consumeSpy.mockResolvedValueOnce({ worktreeId: 'w2', jobName: 'j2', mode: 'acp' })
    await expect(worktreeRestart('w2')).resolves.toBe('w2')
    expect(attachSpy).not.toHaveBeenCalled()
  })

  it('attaches when the server reports no mode at all', async () => {
    // A server that predates the field: tui is what every pre-ACP worktree
    // ran, so the old behaviour is the right fallback.
    consumeSpy.mockResolvedValueOnce({ worktreeId: 'w3', jobName: 'j3' })
    await expect(worktreeRestart('w3')).resolves.toBe('w3')
    expect(attachSpy).toHaveBeenCalledWith('w3', 'native')
  })
})
