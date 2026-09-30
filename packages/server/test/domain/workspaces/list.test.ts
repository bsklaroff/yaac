import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn().mockResolvedValue([]),
    listWorkspaceJobs: vi.fn().mockResolvedValue([]),
  }
})

// The join under test reads the recorded rows alongside the real
// observation half, so the leaf mocks above drive it end to end — only the
// substrate is stubbed.
import { listWorkspacePods, LABEL_PREWARMED } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { markWorkspaceTerminating, isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { recordProject } from '#db/project-store'
import { getProjectsDir } from '@yaac/shared/project-paths'
import {
  listActiveWorkspaces,
  _clearListActiveInflightForTests,
} from '#domain/workspaces/list'
import { declareWorkspaceForwards, stopWorkspaceForwarders } from '#drivers/k8s/forwarders/port-forwarders'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listWorkspacePods)

async function writeProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  const full: ProjectMeta = {
    slug,
    remoteUrl: meta.remoteUrl ?? `https://example.com/${slug}`,
    addedAt: meta.addedAt ?? '2026-01-01T00:00:00.000Z',
  }
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await recordProject(full)
}

describe('listActiveWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorkspaceDriver()
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _clearTerminatingForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    _clearTerminatingForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveWorkspaces('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('renders a stopping pod as a non-interactive stopping row, not stale', async () => {
    await writeProject('demo')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'dying' })
    await recordAgentSessions('demo', 'dying', [
      { tool: 'claude', agentSessionId: 'dying', model: 'claude-sonnet-5' },
    ])
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-dying',
      podName: 'yaac-demo-dying-x1',
      workspaceId: 'dying',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: false,
      terminating: true,
      createdAtMs: 1_000,
      labels: {},
    }])
    const result = await listActiveWorkspaces()
    expect(result.stale).toEqual([])
    expect(result.workspaces).toHaveLength(1)
    const row = result.workspaces[0]
    expect(row.workspaceId).toBe('dying')
    expect(row.stopping).toBe(true)
    // Forced 'running' with no waiting stamp, so no attention badge fires.
    expect(row.status).toBe('running')
    expect(row.waitingSinceMs).toBeUndefined()
    // Its conversations stay listed, so the row keeps naming its model, but
    // carry no live status of their own.
    expect(row.agentSessions).toHaveLength(1)
    expect(row.agentSessions[0]).toMatchObject({ model: 'claude-sonnet-5' })
    expect(row.agentSessions[0].status).toBeUndefined()
  })

  it('prunes a stopping mark once its pod is gone', async () => {
    markWorkspaceTerminating('ghost')
    mockListPods.mockResolvedValue([]) // pod already torn down
    await listActiveWorkspaces()
    expect(isWorkspaceTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveWorkspaces()
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('hides prewarmed spares from the active session list', async () => {
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-spare',
      podName: 'yaac-demo-spare-x1',
      workspaceId: 'spare1',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_000,
      labels: { [LABEL_PREWARMED]: 'true' },
    }])
    const result = await listActiveWorkspaces()
    // Filtered out before classify, so it never reaches the status probes.
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('throws RUNTIME_UNAVAILABLE when the pod listing fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(listActiveWorkspaces()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('surfaces the base branch recorded at create time', async () => {
    await writeProject('demo')
    await recordWorkspaceCreated({
      projectSlug: 'demo', workspaceId: 'tracked', baseBranch: 'release/2.x',
    })
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'norecord' })

    mockListPods.mockResolvedValue([
      {
        jobName: 'yaac-demo-tracked',
        podName: 'yaac-demo-tracked-x1',
        workspaceId: 'tracked',
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
        workspaceId: 'norecord',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    const result = await listActiveWorkspaces('demo')
    const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
    expect(bySession.get('tracked')?.baseBranch).toBe('release/2.x')
    expect(bySession.get('norecord')?.baseBranch).toBeUndefined()
  })

  it('carries the forwarder registry port mappings on each entry', async () => {
    mockListPods.mockResolvedValue([
      {
        jobName: 'yaac-demo-withports',
        podName: 'yaac-demo-withports-x1',
        workspaceId: 'withports',
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
        workspaceId: 'noports',
        projectSlug: 'demo',
        tool: 'claude',
        phase: 'Running',
        running: true,
        terminating: false,
        createdAtMs: 1_000,
        labels: {},
      },
    ])
    declareWorkspaceForwards('withports', [{ containerPort: 8787, hostPortStart: 9787 }])
    try {
      const result = await listActiveWorkspaces()
      const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
      expect(bySession.get('withports')?.forwardedPorts).toEqual([
        { containerPort: 8787, hostPort: 9787 },
      ])
      expect(bySession.get('noports')?.forwardedPorts).toEqual([])
    } finally {
      stopWorkspaceForwarders('withports')
    }
  })
})

describe('listActiveWorkspaces project filter', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorkspaceDriver()
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('accepts the project filter when the project is recorded', async () => {
    await recordProject({ slug: 'valid', remoteUrl: 'x', addedAt: 'y' })
    const result = await listActiveWorkspaces('valid')
    expect(result.workspaces).toEqual([])
  })

  it('raises ServerError for unknown projects', async () => {
    await expect(listActiveWorkspaces('bogus')).rejects.toBeInstanceOf(ServerError)
  })
})
