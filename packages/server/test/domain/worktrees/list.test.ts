import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorktreeDriver } from '@yaac/test-utils/real-driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorktreePods: vi.fn().mockResolvedValue([]),
    listWorktreeJobs: vi.fn().mockResolvedValue([]),
  }
})

// The join under test reads the recorded rows alongside the real
// observation half, so the leaf mocks above drive it end to end — only the
// substrate is stubbed.
import { listWorktreePods, LABEL_PREWARMED } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { markWorktreeTerminating, isWorktreeTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { closeDb } from '#db/client'
import { recordWorktreeCreated } from '#db/worktree-store'
import {
  getProjectsDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  listActiveWorktrees,
  _clearListActiveInflightForTests,
} from '#domain/worktrees/list'
import {
  _resetDeferredClusterBootForTests,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
} from '#drivers/k8s/substrate/deferred-boot'
import { registerWorktreeForwarders, stopWorktreeForwarders } from '#drivers/k8s/forwarders/port-forwarders'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listWorktreePods)

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

describe('listActiveWorktrees', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorktreeDriver()
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _clearTerminatingForTests()
    _resetDeferredClusterBootForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    _clearTerminatingForTests()
    _resetDeferredClusterBootForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveWorktrees('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('answers empty without a cluster call while the deferred boot is pending', async () => {
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)

    const result = await listActiveWorktrees()
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
      worktreeId: 'dying',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: false,
      terminating: true,
      createdAtMs: 1_000,
      labels: {},
    }])
    const result = await listActiveWorktrees()
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
    markWorktreeTerminating('ghost')
    mockListPods.mockResolvedValue([]) // pod already torn down
    await listActiveWorktrees()
    expect(isWorktreeTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveWorktrees()
    expect(result.worktrees).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('hides prewarmed spares from the active session list', async () => {
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-spare',
      podName: 'yaac-demo-spare-x1',
      worktreeId: 'spare1',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_000,
      labels: { [LABEL_PREWARMED]: 'true' },
    }])
    const result = await listActiveWorktrees()
    // Filtered out before classify, so it never reaches the status probes.
    expect(result.worktrees).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('throws RUNTIME_UNAVAILABLE when the pod listing fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(listActiveWorktrees()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
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
        worktreeId: 'tracked',
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
        worktreeId: 'norecord',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    const result = await listActiveWorktrees('demo')
    const bySession = new Map(result.worktrees.map((s) => [s.worktreeId, s]))
    expect(bySession.get('tracked')?.baseBranch).toBe('release/2.x')
    expect(bySession.get('norecord')?.baseBranch).toBeUndefined()
  })

  it('carries the forwarder registry port mappings on each entry', async () => {
    mockListPods.mockResolvedValue([
      {
        jobName: 'yaac-demo-withports',
        podName: 'yaac-demo-withports-x1',
        worktreeId: 'withports',
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
        worktreeId: 'noports',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    registerWorktreeForwarders('withports', () => {}, [{ containerPort: 8787, hostPort: 9787 }])
    try {
      const result = await listActiveWorktrees()
      const bySession = new Map(result.worktrees.map((s) => [s.worktreeId, s]))
      expect(bySession.get('withports')?.forwardedPorts).toEqual([
        { containerPort: 8787, hostPort: 9787 },
      ])
      expect(bySession.get('noports')?.forwardedPorts).toEqual([])
    } finally {
      stopWorktreeForwarders('withports')
    }
  })
})

describe('listActiveWorktrees project filter', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorktreeDriver()
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('accepts the project filter when project.json exists', async () => {
    await fs.mkdir(projectDir('valid'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir('valid'), 'project.json'),
      JSON.stringify({ slug: 'valid', remoteUrl: 'x', addedAt: 'y' }),
    )
    const result = await listActiveWorktrees('valid')
    expect(result.worktrees).toEqual([])
  })

  it('raises ServerError for unknown projects', async () => {
    await expect(listActiveWorktrees('bogus')).rejects.toBeInstanceOf(ServerError)
  })
})
