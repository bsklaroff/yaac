import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The two things erasing a project's bytes reaches outside the feature for.
// Session teardown and the push-registry delete drive kubectl (and spawn a
// detached script), so they are faked at that boundary; the directories
// below are removed for real, under the temp data dir.
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
import { purgeProjectBytes } from '#features/sessions'
import { projectDir, projectRoots } from '@yaac/shared/project-paths'

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
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string): Promise<void> {
  for (const root of projectRoots(slug)) {
    await fs.mkdir(path.join(root, 'repo'), { recursive: true })
  }
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

describe('purgeProjectBytes', () => {
  it('tears down every live session, drops the registry, then both tier roots', async () => {
    await writeProject('demo')
    await writeProject('keeper')
    mockListPods.mockResolvedValue([pod('demo', 'a'), pod('demo', 'b')])

    await purgeProjectBytes('demo')

    expect(mockListPods).toHaveBeenCalledWith('demo')
    expect(mockCleanup.mock.calls.map(([c]) => c)).toEqual([
      { jobName: 'yaac-demo-a', projectSlug: 'demo', sessionId: 'a' },
      { jobName: 'yaac-demo-b', projectSlug: 'demo', sessionId: 'b' },
    ])
    expect(mockRemoveRegistry).toHaveBeenCalledWith('demo')

    for (const root of projectRoots('demo')) {
      await expect(fs.access(root)).rejects.toThrow()
    }
    await expect(fs.access(projectDir('keeper'))).resolves.toBeUndefined()
  })

  // Best-effort throughout: a cluster that cannot be reached must not stop
  // the directories going away, and the server-start orphan GCs sweep the
  // rest.
  it('still removes the dirs when the cluster is unreachable', async () => {
    await writeProject('demo')
    mockListPods.mockRejectedValue(new Error('connection refused'))
    mockRemoveRegistry.mockRejectedValue(new Error('connection refused'))

    await purgeProjectBytes('demo')

    expect(mockCleanup).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })

  it('carries on when one session fails to tear down', async () => {
    await writeProject('demo')
    mockListPods.mockResolvedValue([pod('demo', 'a'), pod('demo', 'b')])
    mockCleanup.mockRejectedValueOnce(new Error('exec failed'))

    await purgeProjectBytes('demo')

    expect(mockCleanup).toHaveBeenCalledTimes(2)
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })
})
