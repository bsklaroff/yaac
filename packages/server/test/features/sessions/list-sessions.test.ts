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

import { listSessionPods, LABEL_PREWARMED } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { markSessionTerminating, isSessionTerminating, _clearTerminatingForTests } from '#features/sessions/state'
import { closeDb } from '#platform/db/client'
import { recordSessionCreated } from '#features/sessions/store'
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
import { registerSessionForwarders, stopSessionForwarders } from '#features/sessions/forwarders/port-forwarders'
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
    await expect(listActiveSessions('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('answers empty without a cluster call while the deferred boot is pending', async () => {
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)

    const result = await listActiveSessions()
    expect(result.sessions).toEqual([])
    expect(result.stale).toEqual([])
    expect(mockListPods).not.toHaveBeenCalled()

    // The short-circuit still fires the attach (a web-app connect must
    // wake the cluster) — it just doesn't wait for it.
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('renders a terminating pod as a non-interactive terminating row, not stale', async () => {
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
    expect(result.sessions).toHaveLength(1)
    const row = result.sessions[0]
    expect(row.sessionId).toBe('dying')
    expect(row.terminating).toBe(true)
    // Forced 'running' with no waiting stamp, so no attention badge fires.
    expect(row.status).toBe('running')
    expect(row.waitingSinceMs).toBeUndefined()
  })

  it('prunes a terminating mark once its pod is gone', async () => {
    markSessionTerminating('ghost')
    mockListPods.mockResolvedValue([]) // pod already torn down
    await listActiveSessions()
    expect(isSessionTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveSessions()
    expect(result.sessions).toEqual([])
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
    expect(result.sessions).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('throws RUNTIME_UNAVAILABLE when the pod listing fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(listActiveSessions()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('surfaces the base branch recorded at create time', async () => {
    await writeProject('demo')
    await recordSessionCreated({
      projectSlug: 'demo', sessionId: 'tracked', tool: 'claude', baseBranch: 'release/2.x',
    })
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'norecord', tool: 'claude' })

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
    const bySession = new Map(result.sessions.map((s) => [s.sessionId, s]))
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
      const bySession = new Map(result.sessions.map((s) => [s.sessionId, s]))
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
    const result = await listActiveSessions('valid')
    expect(result.sessions).toEqual([])
  })

  it('raises ServerError for unknown projects', async () => {
    await expect(listActiveSessions('bogus')).rejects.toBeInstanceOf(ServerError)
  })
})
