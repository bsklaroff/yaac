import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// listActiveSessions and ensurePrewarmSessions both fan out into many
// other helpers. We mock the leaves (podman, fs-backed helpers) so the
// single-flight wrappers can be exercised without standing up a real
// podman socket or daemon.

vi.mock('@/lib/container/runtime', () => ({
  podman: { listContainers: vi.fn(), getContainer: vi.fn() },
  podmanExecWithRetry: vi.fn(),
  shellPodmanWithRetry: vi.fn(),
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockResolvedValue(true),
  cleanupSession: vi.fn(),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/session/blocked-hosts', () => ({
  readBlockedHosts: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/session/status', () => ({
  getSessionStatus: vi.fn().mockResolvedValue('running'),
  getSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  getToolFromContainer: vi.fn().mockReturnValue('claude'),
}))

import { podman } from '@/lib/container/runtime'
import {
  listActiveSessions,
  _clearListActiveInflightForTests,
} from '@/lib/session/list'
import {
  ensurePrewarmSessions,
  _clearEnsurePrewarmInflightForTests,
} from '@/lib/prewarm'
import { setDataDir } from '@/lib/project/paths'

/* eslint-disable @typescript-eslint/unbound-method */
const mockListContainers = vi.mocked(podman.listContainers)
/* eslint-enable @typescript-eslint/unbound-method */

describe('listActiveSessions single-flight', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-single-flight-list-'))
    setDataDir(tmpDir)
    _clearListActiveInflightForTests()
    mockListContainers.mockReset()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('coalesces overlapping calls with the same filter onto one execution', async () => {
    let resolveList: ((value: unknown[]) => void) | undefined
    mockListContainers.mockReturnValue(new Promise<unknown[]>((res) => {
      resolveList = res
    }) as never)

    const a = listActiveSessions()
    const b = listActiveSessions()
    const c = listActiveSessions()

    // All three callers should be waiting on the single in-flight
    // listContainers; verify by checking the mock call count before
    // we let it resolve.
    expect(mockListContainers).toHaveBeenCalledTimes(1)

    resolveList!([])
    const results = await Promise.all([a, b, c])
    // Same Promise resolution — all three see the same result object.
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
  })

  it('runs again after the prior call settles', async () => {
    mockListContainers.mockResolvedValue([] as never)
    await listActiveSessions()
    await listActiveSessions()
    expect(mockListContainers).toHaveBeenCalledTimes(2)
  })

  it('keeps different filters on separate in-flight slots', async () => {
    // Project dirs must exist so ensureProjectExists doesn't 404.
    await fs.mkdir(path.join(tmpDir, 'projects', 'proj-a'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'projects', 'proj-a', 'project.json'), '{}')
    await fs.mkdir(path.join(tmpDir, 'projects', 'proj-b'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'projects', 'proj-b', 'project.json'), '{}')

    mockListContainers.mockResolvedValue([] as never)

    const [a, b] = await Promise.all([
      listActiveSessions('proj-a'),
      listActiveSessions('proj-b'),
    ])

    // Two distinct executions (one per filter), so listContainers ran
    // twice and the result objects are not the same reference.
    expect(mockListContainers).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })
})

describe('ensurePrewarmSessions single-flight', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-single-flight-prewarm-'))
    setDataDir(tmpDir)
    _clearEnsurePrewarmInflightForTests()
    mockListContainers.mockReset()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('coalesces overlapping calls with the same tool', async () => {
    let resolveList: ((value: unknown[]) => void) | undefined
    mockListContainers.mockReturnValue(new Promise<unknown[]>((res) => {
      resolveList = res
    }) as never)

    const a = ensurePrewarmSessions()
    const b = ensurePrewarmSessions()
    expect(mockListContainers).toHaveBeenCalledTimes(1)

    resolveList!([])
    await Promise.all([a, b])
  })

  it('runs again after the prior call settles', async () => {
    mockListContainers.mockResolvedValue([] as never)
    await ensurePrewarmSessions()
    await ensurePrewarmSessions()
    expect(mockListContainers).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight slot even when the underlying call rejects', async () => {
    mockListContainers.mockRejectedValueOnce(new Error('podman down'))
    await expect(ensurePrewarmSessions()).rejects.toThrow('podman down')
    // Slot must be released — a follow-up call should attempt again.
    mockListContainers.mockResolvedValueOnce([] as never)
    await ensurePrewarmSessions()
    expect(mockListContainers).toHaveBeenCalledTimes(2)
  })
})
