import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'

// Session teardown spawns a detached script, so it is faked at the feature
// boundary; everything the RUNTIME holds is faked at the contract, and the
// directories below are removed for real, under the temp data dir.
vi.mock('#domain/worktrees/cleanup', () => ({ cleanupWorktreeDetached: vi.fn() }))

import { cleanupWorktreeDetached } from '#domain/worktrees/cleanup'
import { purgeProjectBytes } from '#domain/worktrees'
import { projectDir, projectRoots } from '@yaac/shared/project-paths'
import type { RuntimeHandle } from '#runtime/contract'

const mockCleanup = vi.mocked(cleanupWorktreeDetached)
const mockList = vi.fn<(projectSlug?: string) => Promise<RuntimeHandle[]>>()
const mockDestroySubstrate = vi.fn<(projectSlug: string) => Promise<void>>()

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockCleanup.mockReset().mockResolvedValue(undefined)
  mockList.mockReset().mockResolvedValue([])
  mockDestroySubstrate.mockReset().mockResolvedValue(undefined)
  installFakeWorktreeRuntime({
    list: mockList,
    destroyProjectSubstrate: mockDestroySubstrate,
  })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string): Promise<void> {
  for (const root of projectRoots(slug)) {
    await fs.mkdir(path.join(root, 'repo'), { recursive: true })
  }
}

function workspace(projectSlug: string, workspaceId: string): RuntimeHandle {
  return handleFixture({
    jobName: `yaac-${projectSlug}-${workspaceId}`,
    workspaceId,
    projectSlug,
  })
}

describe('purgeProjectBytes', () => {
  it('tears down every live session, drops what the runtime holds, then both tier roots', async () => {
    await writeProject('demo')
    await writeProject('keeper')
    mockList.mockResolvedValue([workspace('demo', 'a'), workspace('demo', 'b')])

    await purgeProjectBytes('demo')

    expect(mockList).toHaveBeenCalledWith('demo')
    expect(mockCleanup.mock.calls.map(([c]) => c)).toEqual([
      { jobName: 'yaac-demo-a', projectSlug: 'demo', worktreeId: 'a' },
      { jobName: 'yaac-demo-b', projectSlug: 'demo', worktreeId: 'b' },
    ])
    expect(mockDestroySubstrate).toHaveBeenCalledWith('demo')

    for (const root of projectRoots('demo')) {
      await expect(fs.access(root)).rejects.toThrow()
    }
    await expect(fs.access(projectDir('keeper'))).resolves.toBeUndefined()
  })

  // Best-effort throughout: a runtime that cannot be reached must not stop
  // the directories going away, and the server-start orphan GCs sweep the
  // rest.
  it('still removes the dirs when the runtime is unreachable', async () => {
    await writeProject('demo')
    mockList.mockRejectedValue(new Error('connection refused'))
    mockDestroySubstrate.mockRejectedValue(new Error('connection refused'))

    await purgeProjectBytes('demo')

    expect(mockCleanup).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })

  it('carries on when one session fails to tear down', async () => {
    await writeProject('demo')
    mockList.mockResolvedValue([workspace('demo', 'a'), workspace('demo', 'b')])
    mockCleanup.mockRejectedValueOnce(new Error('exec failed'))

    await purgeProjectBytes('demo')

    expect(mockCleanup).toHaveBeenCalledTimes(2)
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })
})
