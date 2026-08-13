import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getWorktreeBlockedHosts, getWorktreeDetail, getWorktreePrompt } from '#domain/worktrees/detail'
import { ServerError } from '@yaac/shared/errors'
import type { VirtualClusterStatus } from '#drivers/contract'

// Every helper here resolves the workspace through the runtime first.
const mockFind = vi.fn()
const mockBlockedHosts = vi.fn<(workspaceId: string) => Promise<string[]>>()
const mockVcluster = vi.fn<(workspaceId: string) => Promise<VirtualClusterStatus | null>>()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockFind.mockReset().mockResolvedValue(undefined)
    mockBlockedHosts.mockReset().mockResolvedValue([])
    mockVcluster.mockReset().mockResolvedValue(null)
    installFakeWorktreeDriver({
      find: mockFind,
      blockedHosts: mockBlockedHosts,
      virtualClusterStatus: mockVcluster,
    })
    tmpDir = await createTempDataDir()
    // The default above is a runtime running nothing: every helper here
    // resolves the workspace first, so that is what proves each one refuses
    // rather than half-answering.
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getWorktreeDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreeBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreePrompt throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreePrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreeDetail reports what the runtime says about the workspace', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1', projectSlug: 'demo' }))
    mockBlockedHosts.mockResolvedValue(['evil.example', 'blocked.example'])
    mockVcluster.mockResolvedValue({ name: 'yvc-w1', ready: true, phase: 'ready' })

    const detail = await getWorktreeDetail('w1')

    expect(mockBlockedHosts).toHaveBeenCalledWith('w1')
    expect(detail).toMatchObject({
      worktreeId: 'w1',
      projectSlug: 'demo',
      blockedHostsCount: 2,
      virtualCluster: { name: 'yvc-w1', ready: true, phase: 'ready' },
    })
  })

  // A workspace with no nested cluster is the common case, and the key is
  // omitted rather than sent as null — the wire shape the webapp reads.
  it('getWorktreeDetail omits the nested cluster when there is none', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    expect(await getWorktreeDetail('w1')).not.toHaveProperty('virtualCluster')
  })

  // Detail has to render even when that one extra read hiccups: it is a
  // display surface, and a blank nested-cluster block beats an error page.
  it('getWorktreeDetail still renders when the nested-cluster read fails', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockVcluster.mockRejectedValue(new Error('apiserver down'))

    const detail = await getWorktreeDetail('w1')
    expect(detail.worktreeId).toBe('w1')
    expect(detail.virtualCluster).toBeUndefined()
  })

  it('getWorktreeBlockedHosts relays the runtime’s list', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockBlockedHosts.mockResolvedValue(['evil.example'])
    await expect(getWorktreeBlockedHosts('w1')).resolves.toEqual(['evil.example'])
  })
})
