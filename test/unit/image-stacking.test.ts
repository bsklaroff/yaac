import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

const HASH_RE = '[0-9a-f]{16}'

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

  async function loadModule() {
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
        const buildArgPairs: string[] = []
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--build-arg') buildArgPairs.push(args[i + 1])
        }
        const suffix = buildArgPairs.length ? ` [${buildArgPairs.join(',')}]` : ''
        operations.push(`build ${imageName}${suffix}`)
        const emitter = new EventEmitter()
        process.nextTick(() => emitter.emit('close', 0))
        return emitter
      }),
    }))

    const mod = await import('@/lib/image-builder')
    return mod
  }

  it('builds base → current tag → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-base\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^tag yaac-base:${HASH_RE} → yaac-current$`))
    expect(operations[2]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE}$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('returns base tag directly when no Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE}$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('uses Dockerfile.yaac instead of Dockerfile.default when present', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE}$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('layers Dockerfile.yaac on top of default when it uses FROM yaac-base', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // First builds the default base, then layers Dockerfile.yaac on top (both tagged as yaac-base)
    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('builds nestable layer when nestedContainers is true', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base-nestable:${HASH_RE}$`))
  })

  it('builds nestable + user layers when both are enabled', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(4)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(operations[2]).toMatch(new RegExp(`^tag yaac-base-nestable:${HASH_RE} → yaac-current$`))
    expect(operations[3]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE}$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('builds nestable layer on top of standalone Dockerfile.yaac when nestedContainers is true', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base-nestable:${HASH_RE}$`))
  })

  it('builds nestable layer on top of layered Dockerfile.yaac when nestedContainers is true', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(operations[2]).toMatch(new RegExp(`^build yaac-base-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base-nestable:${HASH_RE}$`))
  })

  it('ensureImageByTag builds when image does not exist', async () => {
    const { ensureImageByTag } = await loadModule()
    await ensureImageByTag('test-img:abc', '/some/Dockerfile', '/some')
    expect(operations).toEqual(['build test-img:abc'])
  })

})
