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
    // Reset the module cache so runtime.ts re-evaluates `promisify(execFile)`
    // against the mocked child_process below. Without this, execFileAsync keeps
    // the real execFile captured on first load and imageExists hits real podman
    // — which can return true for yaac-base:<hash> images that exist on the
    // dev machine, causing layers to be silently skipped. The reset also
    // wipes the paths.ts data-dir singleton, so we re-apply setDataDir on the
    // freshly-imported module below.
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((...allArgs: unknown[]) => {
        const args = allArgs[1] as string[]
        const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void

        if (args[0] === 'image' && args[1] === 'inspect') {
          cb(new Error('no such image'), { stdout: '', stderr: '' })
          return
        }
        cb(null, { stdout: '', stderr: '' })
      }),
      spawn: vi.fn((_cmd: string, args: string[]) => {
        const tIdx = args.indexOf('-t')
        const imageName = tIdx >= 0 ? args[tIdx + 1] : 'unknown'
        const buildArgPairs: string[] = []
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--build-arg' && !args[i + 1]?.startsWith('SSL_CERT_FILE=')) buildArgPairs.push(args[i + 1])
        }
        const suffix = buildArgPairs.length ? ` [${buildArgPairs.join(',')}]` : ''
        operations.push(`build ${imageName}${suffix}`)
        const emitter = new EventEmitter()
        process.nextTick(() => emitter.emit('close', 0))
        return emitter
      }),
    }))

    const paths = await import('@/lib/project/paths')
    paths.setDataDir(dataDir)
    const mod = await import('@/lib/container/image-builder')
    return mod
  }

  it('builds base → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
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

  it('layers Dockerfile.yaac on top of default when it uses FROM ${BASE_IMAGE}', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // First builds the default base, then layers Dockerfile.yaac on top via build arg
    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('treats Dockerfile.yaac with FROM yaac-base (no ARG) as standalone', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // No default build — treated as standalone replacement
    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE}$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('rejects Dockerfile.user without ARG BASE_IMAGE', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    await expect(ensureImage('myproject')).rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM \${BASE_IMAGE}`')
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
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE}$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-base-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(operations[2]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-base-nestable:${HASH_RE}\\]$`))
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
    await fs.writeFile(path.join(overrideDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

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
