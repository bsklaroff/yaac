import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    getContainer: vi.fn(),
    listContainers: vi.fn(),
  },
  shellPodmanWithRetry: vi.fn(),
}))

import { podman, shellPodmanWithRetry } from '@/lib/container/runtime'
import {
  isTmuxSessionAlive,
  cleanupSession,
  cleanupSessionDetached,
  sessionModulesDir,
  gcOrphanEphemeralModuleDirs,
  _clearTmuxAliveCacheForTests,
} from '@/lib/session/cleanup'
import { setDataDir } from '@/lib/project/paths'

/* eslint-disable @typescript-eslint/unbound-method */
const mockListContainers = vi.mocked(podman.listContainers)
const mockShellPodman = vi.mocked(shellPodmanWithRetry)
const mockGetContainer = vi.mocked(podman.getContainer)
/* eslint-enable @typescript-eslint/unbound-method */

describe('isTmuxSessionAlive', () => {
  beforeEach(() => {
    _clearTmuxAliveCacheForTests()
    mockShellPodman.mockReset()
  })

  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
  })

  it('returns true when the underlying podman exec succeeds', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(isTmuxSessionAlive('c-1')).resolves.toBe(true)
    expect(mockShellPodman).toHaveBeenCalledTimes(1)
  })

  it('returns false when the underlying podman exec fails', async () => {
    mockShellPodman.mockRejectedValue(new Error('no such container'))
    await expect(isTmuxSessionAlive('c-dead')).resolves.toBe(false)
  })

  it('serves repeat calls from the TTL cache without re-probing', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })
    await isTmuxSessionAlive('c-cache')
    await isTmuxSessionAlive('c-cache')
    await isTmuxSessionAlive('c-cache')
    expect(mockShellPodman).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    let resolveProbe: (() => void) | undefined
    mockShellPodman.mockReturnValue(new Promise((res) => {
      resolveProbe = () => res({ stdout: '', stderr: '' })
    }))

    const p1 = isTmuxSessionAlive('c-coalesce')
    const p2 = isTmuxSessionAlive('c-coalesce')
    const p3 = isTmuxSessionAlive('c-coalesce')

    expect(mockShellPodman).toHaveBeenCalledTimes(1)
    resolveProbe!()
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true])
    expect(mockShellPodman).toHaveBeenCalledTimes(1)
  })

  it('caches per container name, not globally', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })
    await isTmuxSessionAlive('c-A')
    await isTmuxSessionAlive('c-B')
    expect(mockShellPodman).toHaveBeenCalledTimes(2)
  })

  it('cleanupSession evicts the cache entry for that container', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })
    await isTmuxSessionAlive('c-evict')
    expect(mockShellPodman).toHaveBeenCalledTimes(1)

    mockGetContainer.mockReturnValue({
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as never)
    await cleanupSession({
      containerName: 'c-evict',
      projectSlug: 'p',
      sessionId: 's-evict',
    })

    // Cache cleared — next probe re-runs the podman exec.
    await isTmuxSessionAlive('c-evict')
    expect(mockShellPodman).toHaveBeenCalledTimes(2)
  })
})

describe('cleanupSession', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSession).toBe('function')
  })
})

describe('cleanupSessionDetached', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSessionDetached).toBe('function')
  })
})

describe('sessionModulesDir', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-sessionmodules-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('returns <dataDir>/projects/<slug>/.cached-packages/modules/<sid>', () => {
    const result = sessionModulesDir('my-proj', 'sess-abc')
    expect(result).toBe(
      path.join(dataDir, 'projects', 'my-proj', '.cached-packages', 'modules', 'sess-abc'),
    )
  })
})

describe('gcOrphanEphemeralModuleDirs', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
    setDataDir(dataDir)
    mockListContainers.mockReset()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function seedModulesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'projects', slug, '.cached-packages', 'modules', sid)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  it('removes dirs whose session container is gone and leaves live ones', async () => {
    const live = await seedModulesDir('proj-a', 'live-1')
    const deadA = await seedModulesDir('proj-a', 'dead-1')
    const deadB = await seedModulesDir('proj-b', 'dead-2')

    mockListContainers.mockResolvedValue([
      { Labels: { 'yaac.session-id': 'live-1' } },
    ] as never)

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(live)).resolves.toBeUndefined()
    await expect(fs.access(deadA)).rejects.toThrow()
    await expect(fs.access(deadB)).rejects.toThrow()
  })

  it('is a no-op when the projects dir does not exist', async () => {
    // No projects dir seeded at all.
    mockListContainers.mockResolvedValue([] as never)
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('skips projects that have no modules dir', async () => {
    // Seed only the project dir, not .cached-packages/modules/.
    await fs.mkdir(path.join(dataDir, 'projects', 'proj-empty'), { recursive: true })
    mockListContainers.mockResolvedValue([] as never)
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('returns quietly if container listing fails', async () => {
    const dead = await seedModulesDir('proj-a', 'would-be-removed')
    mockListContainers.mockRejectedValue(new Error('podman offline'))

    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    // Nothing was removed because we bailed out before the sweep.
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })

  it('filters by yaac.data-dir so other yaac installs are not considered', async () => {
    mockListContainers.mockResolvedValue([] as never)
    await gcOrphanEphemeralModuleDirs()

    const filters = mockListContainers.mock.calls[0]?.[0] as
      | { filters?: { label?: string[] } } | undefined
    expect(filters?.filters?.label).toContain(`yaac.data-dir=${dataDir}`)
  })
})
