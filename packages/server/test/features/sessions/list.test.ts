import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

// The join under test reads the server's rows alongside a herd's report.
// The herd here is the real observation half, so the leaf mocks above still
// drive it end to end — only the boundary between them is stubbed.
import { observeWorkspaces } from '#features/sessions/observe'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import { listSessionPods, LABEL_PREWARMED } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { markSessionTerminating, isSessionTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import { closeDb } from '#platform/db/client'
import { recordWorktreeCreated } from '#features/records/worktree-store'
import {
  getProjectsDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  listActiveSessions,
  _clearListActiveInflightForTests,
} from '#features/sessions/list'
import {
  _resetDeferredClusterBootForTests,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
} from '#platform/k8s/deferred-boot'
import { registerSessionForwarders, stopSessionForwarders } from '#features/forwarders/port-forwarders'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listSessionPods)

async function writeProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  const full: ProjectMeta = {
    slug,
    remoteUrl: meta.remoteUrl ?? `https://example.com/${slug}`,
    addedAt: meta.addedAt ?? '2026-01-01T00:00:00.000Z',
  }
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(full))
}

describe('listActiveSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _setHerdForTests({ workspaces: { observe: observeWorkspaces } })
    _clearTerminatingForTests()
    _resetDeferredClusterBootForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    _resetHerdForTests()
    _clearTerminatingForTests()
    _resetDeferredClusterBootForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveSessions('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('answers empty without a cluster call while the deferred boot is pending', async () => {
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)

    const result = await listActiveSessions()
    expect(result.worktrees).toEqual([])
    expect(result.stale).toEqual([])
    expect(mockListPods).not.toHaveBeenCalled()

    // The short-circuit still fires the attach (a web-app connect must
    // wake the cluster) — it just doesn't wait for it.
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('renders a stopping pod as a non-interactive stopping row, not stale', async () => {
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-dying',
      podName: 'yaac-demo-dying-x1',
      sessionId: 'dying',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: false,
      terminating: true,
      createdAtMs: 1_000,
      labels: {},
    }])
    const result = await listActiveSessions()
    expect(result.stale).toEqual([])
    expect(result.worktrees).toHaveLength(1)
    const row = result.worktrees[0]
    expect(row.worktreeId).toBe('dying')
    expect(row.stopping).toBe(true)
    // Forced 'running' with no waiting stamp, so no attention badge fires.
    expect(row.status).toBe('running')
    expect(row.waitingSinceMs).toBeUndefined()
  })

  it('prunes a stopping mark once its pod is gone', async () => {
    markSessionTerminating('ghost')
    mockListPods.mockResolvedValue([]) // pod already torn down
    await listActiveSessions()
    expect(isSessionTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveSessions()
    expect(result.worktrees).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('hides prewarmed spares from the active session list', async () => {
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-spare',
      podName: 'yaac-demo-spare-x1',
      sessionId: 'spare1',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_000,
      labels: { [LABEL_PREWARMED]: 'true' },
    }])
    const result = await listActiveSessions()
    // Filtered out before classify, so it never reaches the status probes.
    expect(result.worktrees).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('throws RUNTIME_UNAVAILABLE when the pod listing fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(listActiveSessions()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('surfaces the base branch recorded at create time', async () => {
    await writeProject('demo')
    await recordWorktreeCreated({
      projectSlug: 'demo', worktreeId: 'tracked', baseBranch: 'release/2.x',
    })
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'norecord' })

    mockListPods.mockResolvedValue([
      {
        jobName: 'yaac-demo-tracked',
        podName: 'yaac-demo-tracked-x1',
        sessionId: 'tracked',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
      {
        jobName: 'yaac-demo-norecord',
        podName: 'yaac-demo-norecord-x1',
        sessionId: 'norecord',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    const result = await listActiveSessions('demo')
    const bySession = new Map(result.worktrees.map((s) => [s.worktreeId, s]))
    expect(bySession.get('tracked')?.baseBranch).toBe('release/2.x')
    expect(bySession.get('norecord')?.baseBranch).toBeUndefined()
  })

  it('carries the forwarder registry port mappings on each entry', async () => {
    mockListPods.mockResolvedValue([
      {
        jobName: 'yaac-demo-withports',
        podName: 'yaac-demo-withports-x1',
        sessionId: 'withports',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
      {
        jobName: 'yaac-demo-noports',
        podName: 'yaac-demo-noports-x1',
        sessionId: 'noports',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    registerSessionForwarders('withports', () => {}, [{ containerPort: 8787, hostPort: 9787 }])
    try {
      const result = await listActiveSessions()
      const bySession = new Map(result.worktrees.map((s) => [s.worktreeId, s]))
      expect(bySession.get('withports')?.forwardedPorts).toEqual([
        { containerPort: 8787, hostPort: 9787 },
      ])
      expect(bySession.get('noports')?.forwardedPorts).toEqual([])
    } finally {
      stopSessionForwarders('withports')
    }
  })
})

describe('listActiveSessions project filter', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _setHerdForTests({ workspaces: { observe: observeWorkspaces } })
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    _resetHerdForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('accepts the project filter when project.json exists', async () => {
    await fs.mkdir(projectDir('valid'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir('valid'), 'project.json'),
      JSON.stringify({ slug: 'valid', remoteUrl: 'x', addedAt: 'y' }),
    )
    const result = await listActiveSessions('valid')
    expect(result.worktrees).toEqual([])
  })

  it('raises ServerError for unknown projects', async () => {
    await expect(listActiveSessions('bogus')).rejects.toBeInstanceOf(ServerError)
  })
})
