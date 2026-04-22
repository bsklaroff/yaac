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

import { podman } from '@/lib/container/runtime'
import {
  isTmuxSessionAlive,
  cleanupSession,
  cleanupSessionDetached,
  sessionModulesDir,
  gcOrphanEphemeralModuleDirs,
} from '@/lib/session/cleanup'
import { setDataDir } from '@/lib/project/paths'

/* eslint-disable @typescript-eslint/unbound-method */
const mockListContainers = vi.mocked(podman.listContainers)
/* eslint-enable @typescript-eslint/unbound-method */

describe('isTmuxSessionAlive', () => {
  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
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
