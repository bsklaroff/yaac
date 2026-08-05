import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The three things a remove reaches outside the feature for. Session
// teardown and the push-registry delete drive kubectl (and spawn a detached
// script), so they are faked at that boundary; the session rows below are
// deleted for real, against the temp data dir's database.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(),
}))
vi.mock('#features/sessions/cleanup', () => ({ cleanupSessionDetached: vi.fn() }))
vi.mock('#features/cluster/project-registry', () => ({ removeProjectRegistry: vi.fn() }))

import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { removeProjectRegistry } from '#features/cluster/project-registry'
import { removeProject } from '#features/sessions'
import { listWorktreeRows, recordWorktreeCreated } from '#features/sessions/worktree-store'
import { closeDb } from '#platform/db/client'
import { projectDir } from '@yaac/shared/project-paths'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listSessionPods)
const mockCleanup = vi.mocked(cleanupSessionDetached)
const mockRemoveRegistry = vi.mocked(removeProjectRegistry)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockListPods.mockReset().mockResolvedValue([])
  mockCleanup.mockReset().mockResolvedValue(undefined)
  mockRemoveRegistry.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string): Promise<void> {
  const dir = projectDir(slug)
  await fs.mkdir(path.join(dir, 'repo'), { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: `https://example.com/${slug}`,
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

function pod(projectSlug: string, sessionId: string): SessionPod {
  return {
    jobName: `yaac-${projectSlug}-${sessionId}`,
    podName: `yaac-${projectSlug}-${sessionId}-abcde`,
    sessionId,
    projectSlug,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

describe('removeProject', () => {
  it('tears down every live session, drops the registry and rows, then the dir', async () => {
    await writeProject('demo')
    await writeProject('keeper')
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'a' })
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'b' })
    await recordWorktreeCreated({ projectSlug: 'keeper', worktreeId: 'c' })
    mockListPods.mockResolvedValue([pod('demo', 'a'), pod('demo', 'b')])

    await removeProject('demo')

    expect(mockListPods).toHaveBeenCalledWith('demo')
    expect(mockCleanup.mock.calls.map(([c]) => c)).toEqual([
      { jobName: 'yaac-demo-a', projectSlug: 'demo', sessionId: 'a' },
      { jobName: 'yaac-demo-b', projectSlug: 'demo', sessionId: 'b' },
    ])
    expect(mockRemoveRegistry).toHaveBeenCalledWith('demo')

    // Only this project's rows go: the deleted listing is row-driven, and
    // the worktrees they point at went with the dir.
    expect((await listWorktreeRows()).map((r) => r.worktreeId)).toEqual(['c'])
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
    await expect(fs.access(projectDir('keeper'))).resolves.toBeUndefined()
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockRemoveRegistry).not.toHaveBeenCalled()
  })

  it('still removes the dir when the cluster is unreachable', async () => {
    await writeProject('demo')
    mockListPods.mockRejectedValue(new Error('connection refused'))
    mockRemoveRegistry.mockRejectedValue(new Error('connection refused'))

    await removeProject('demo')

    expect(mockCleanup).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })

  it('carries on when one session fails to tear down', async () => {
    await writeProject('demo')
    mockListPods.mockResolvedValue([pod('demo', 'a'), pod('demo', 'b')])
    mockCleanup.mockRejectedValueOnce(new Error('exec failed'))

    await removeProject('demo')

    expect(mockCleanup).toHaveBeenCalledTimes(2)
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })
})
