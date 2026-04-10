import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

describe('ensureImage layer stacking', () => {
  let dataDir: string
  const operations: string[] = []

  beforeEach(async () => {
    operations.length = 0
    dataDir = await createTempDataDir()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.doUnmock('node:child_process')
    await cleanupTempDir(dataDir)
  })

  async function loadEnsureImage() {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((...allArgs: unknown[]) => {
        const args = allArgs[1] as string[]
        const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void

        if (args[0] === 'image' && args[1] === 'inspect') {
          cb(new Error('no such image'), { stdout: '', stderr: '' })
          return
        }
        if (args[0] === 'tag') {
          operations.push(`tag ${args[1]} → ${args[2]}`)
          cb(null, { stdout: '', stderr: '' })
          return
        }
        cb(null, { stdout: '', stderr: '' })
      }),
      spawn: vi.fn((_cmd: string, args: string[]) => {
        const tIdx = args.indexOf('-t')
        const imageName = tIdx >= 0 ? args[tIdx + 1] : 'unknown'
        operations.push(`build ${imageName}`)
        const emitter = new EventEmitter()
        process.nextTick(() => emitter.emit('close', 0))
        return emitter
      }),
    }))

    const { ensureImage } = await import('@/lib/image-builder')
    return ensureImage
  }

  it('builds default → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-base\nRUN echo user\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      'build yaac-base',
      'tag yaac-base → yaac-current',
      'build yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('tags default as final when no Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      'build yaac-base',
      'tag yaac-base → yaac-current',
      'tag yaac-base → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('uses Dockerfile.yaac instead of Dockerfile.default when present', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      'build yaac-base',
      'tag yaac-base → yaac-current',
      'tag yaac-base → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('builds nestable layer when nestedContainers is true', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toEqual([
      'build yaac-base',
      'build yaac-base-nestable',
      'tag yaac-base-nestable → yaac-current',
      'tag yaac-base-nestable → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('builds nestable + user layers when both are enabled', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toEqual([
      'build yaac-base',
      'build yaac-base-nestable',
      'tag yaac-base-nestable → yaac-current',
      'build yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('builds nestable layer on top of Dockerfile.yaac when nestedContainers is true', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toEqual([
      'build yaac-base',
      'build yaac-base-nestable',
      'tag yaac-base-nestable → yaac-current',
      'tag yaac-base-nestable → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })
})
