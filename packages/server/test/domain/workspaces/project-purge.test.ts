import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { purgeProjectBytes } from '#domain/workspaces'
import { closeDb } from '#db/client'
import { nodeLocalProjectPath, projectDir } from '@yaac/shared/project-paths'
import type { ProjectRef, RuntimeHandle } from '#drivers/contract'

// The runtime is a fake driver; workspace teardown and the directories run
// for real under the temp data dir. A torn-down workspace is deregistered.
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()
const mockList = vi.fn<(projectSlug?: string) => Promise<RuntimeHandle[]>>()
const mockDestroySubstrate = vi.fn<(project: ProjectRef) => Promise<void>>()

const DEMO: ProjectRef = { slug: 'demo', id: '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d' }
const KEEPER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockDeregister.mockReset().mockResolvedValue(undefined)
  mockList.mockReset().mockResolvedValue([])
  mockDestroySubstrate.mockReset().mockResolvedValue(undefined)
  installFakeWorkspaceDriver({
    list: mockList,
    destroyProjectSubstrate: mockDestroySubstrate,
    deregisterWorkspace: mockDeregister,
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string, id: string): Promise<void> {
  for (const root of [projectDir(slug), nodeLocalProjectPath(id)]) {
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
  it('tears down every live session, drops what the runtime holds, then the global tree', async () => {
    await writeProject('demo', DEMO.id)
    await writeProject('keeper', KEEPER_ID)
    mockList.mockResolvedValue([workspace('demo', 'a'), workspace('demo', 'b')])

    await purgeProjectBytes(DEMO)

    // First argument only: the fake records a trailing undefined opts.
    expect(mockList.mock.calls.map(([slug]) => slug)).toEqual(['demo'])
    expect(mockDeregister.mock.calls).toEqual([['a'], ['b']])
    expect(mockDestroySubstrate).toHaveBeenCalledWith(DEMO)

    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
    // The node-local tree is the driver's to remove; it may live on
    // another machine.
    await expect(fs.access(nodeLocalProjectPath(DEMO.id))).resolves.toBeUndefined()
    await expect(fs.access(projectDir('keeper'))).resolves.toBeUndefined()
  })

  // Best effort: an unreachable runtime must not keep the directories
  // around. The orphan GCs sweep whatever is left.
  it('still removes the dirs when the runtime is unreachable', async () => {
    await writeProject('demo', DEMO.id)
    mockList.mockRejectedValue(new Error('connection refused'))
    mockDestroySubstrate.mockRejectedValue(new Error('connection refused'))

    await purgeProjectBytes(DEMO)

    expect(mockDeregister).not.toHaveBeenCalled()
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })

  it('carries on when one session fails to tear down', async () => {
    await writeProject('demo', DEMO.id)
    mockList.mockResolvedValue([workspace('demo', 'a'), workspace('demo', 'b')])
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))

    await purgeProjectBytes(DEMO)

    expect(mockDeregister).toHaveBeenCalledTimes(2)
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
  })
})
