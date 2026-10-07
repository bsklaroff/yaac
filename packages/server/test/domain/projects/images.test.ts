import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { dismissImageBuild, retryImageBuild } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb } from '#db'
import { projectConfigDir } from '@yaac/shared/project-paths'
import type { ImageBuildEntry, ImageLayerName } from '@yaac/shared/types'
import type { ProjectReaders } from '#drivers/contract'

const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: 'b0b0b0b0-0000-4000-8000-000000000000' } as const

const mockRetry = vi.fn<(id: string, projects: ProjectReaders) => boolean>()
const mockDismiss = vi.fn<(id: string) => boolean>()

/** A finished build of `layer` for the demo project, as the feed lists it. */
function feedWith(layer: ImageLayerName): void {
  const build: ImageBuildEntry = {
    id: 'b1', tag: 't', layer, projectIds: [DEMO_PROJECT_ID], reason: 'prewarm',
    status: 'failed', startedAt: '2026-01-01 00:00:00',
  }
  installFakeWorkspaceDriver({
    listImageBuilds: () => [build],
    retryImageBuild: mockRetry,
    dismissImageBuild: mockDismiss,
  })
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  mockRetry.mockReturnValue(true)
  tmpDir = await createTempDataDir()
  await recordTestProject(DEMO_PROJECT_ID)
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('retryImageBuild', () => {
  // The runtime cannot read config or rows itself; a rebuild without the
  // config would drop a nested project's nestable layer, and one without
  // the owner would top the chain with the wrong Dockerfile.user.
  it('hands the runtime each project’s config and owner', async () => {
    feedWith('project')
    const dir = projectConfigDir(DEMO_PROJECT_ID)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'yaac-config.json'), JSON.stringify({ nestedContainers: true }))

    expect(await retryImageBuild(owner, 'b1')).toBe(true)

    const readers = mockRetry.mock.calls[0][1]
    await expect(readers.projectConfig(DEMO_PROJECT_ID)).resolves.toEqual({ nestedContainers: true })
    await expect(readers.projectConfig('unconfigured')).resolves.toBeUndefined()
    await expect(readers.projectOwner(DEMO_PROJECT_ID)).resolves.toBe(BUILT_IN_USER_ID)
    await expect(readers.projectOwner('00000000-0000-4000-8000-00000000dead')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets only the owner retry a project’s own layers, and anyone a shared one', async () => {
    for (const layer of ['project', 'user'] as const) {
      feedWith(layer)
      await expect(retryImageBuild(teammate, 'b1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(mockRetry).not.toHaveBeenCalled()
    feedWith('base')
    expect(await retryImageBuild(teammate, 'b1')).toBe(true)
  })

  // A dismissed build is off the feed but still known to the runtime, so
  // a build the check cannot see must not be retried.
  it('retries nothing the feed does not list', async () => {
    feedWith('project')
    expect(await retryImageBuild(teammate, 'dismissed')).toBe(false)
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('reports that there was nothing to retry', async () => {
    feedWith('base')
    mockRetry.mockReturnValue(false)
    expect(await retryImageBuild(teammate, 'b1')).toBe(false)
  })
})

describe('dismissImageBuild', () => {
  it('lets only the owner dismiss a project’s own layers, and anyone a shared one', async () => {
    feedWith('user')
    await expect(dismissImageBuild(teammate, 'b1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mockDismiss).not.toHaveBeenCalled()
    await dismissImageBuild(owner, 'b1')
    expect(mockDismiss).toHaveBeenCalledExactlyOnceWith('b1')

    feedWith('tools')
    await dismissImageBuild(teammate, 'b1')
    expect(mockDismiss).toHaveBeenCalledTimes(2)
  })
})
