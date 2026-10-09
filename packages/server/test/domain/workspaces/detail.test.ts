import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { ServerError } from '@yaac/shared/errors'
import { getWorkspaceBlockedHosts, getWorkspaceDetail } from '#domain/workspaces/detail'

const mockFind = vi.fn()
const mockBlockedHosts = vi.fn<(workspaceId: string) => Promise<string[]>>()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockFind.mockReset().mockResolvedValue(undefined)
    mockBlockedHosts.mockReset().mockResolvedValue([])
    installFakeWorkspaceDriver({
      find: mockFind,
      blockedHosts: mockBlockedHosts,
    })
    tmpDir = await createTempDataDir()
    // By default nothing is running, so each helper must refuse outright.
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getWorkspaceDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorkspaceDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getWorkspaceDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorkspaceBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorkspaceBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorkspaceDetail reports what the runtime says about the workspace', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1', projectId: DEMO_PROJECT_ID }))
    mockBlockedHosts.mockResolvedValue(['evil.example', 'blocked.example'])

    const detail = await getWorkspaceDetail('w1')

    expect(mockBlockedHosts).toHaveBeenCalledWith('w1')
    expect(detail).toMatchObject({
      workspaceId: 'w1',
      projectId: DEMO_PROJECT_ID,
      blockedHostsCount: 2,
    })
  })

  it('getWorkspaceBlockedHosts relays the runtime’s list', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockBlockedHosts.mockResolvedValue(['evil.example'])
    await expect(getWorkspaceBlockedHosts('w1')).resolves.toEqual(['evil.example'])
  })
})
