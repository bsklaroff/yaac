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
      exec: vi.fn((_cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (...cbArgs: unknown[]) => void
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
        const noCache = args.includes('--no-cache') ? ' --no-cache' : ''
        operations.push(`build ${imageName}${suffix}${noCache}`)
        const emitter = new EventEmitter()
        process.nextTick(() => emitter.emit('close', 0))
        return emitter
      }),
    }))

    // Dynamic imports are required: vi.resetModules() above invalidates the
    // module cache, and we need these fresh imports to pick up the doMock
    // above — static imports would keep the stale, pre-reset bindings.
    // eslint-disable-next-line no-restricted-syntax
    const paths = await import('@yaac/shared/project-paths')
    paths.setDataDir(dataDir)
    // eslint-disable-next-line no-restricted-syntax
    const builder = await import('@yaac/server/lib/container/image-builder')
    // eslint-disable-next-line no-restricted-syntax
    const coordinator = await import('@yaac/server/lib/container/build-coordinator')
    return { ...builder, ...coordinator }
  }

  it('builds base → tools → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(operations[2]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('builds base → tools and returns tools tag when no Dockerfile.user exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('uses Dockerfile.yaac instead of Dockerfile.default when present', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // Standalone Dockerfile.yaac owns its own toolchain — no tools layer.
    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('layers Dockerfile.yaac on top of tools when it uses FROM ${BASE_IMAGE}', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // base → tools → yaac (layered on tools, not on default)
    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(operations[2]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('treats Dockerfile.yaac with FROM yaac-base (no ARG) as standalone', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject')

    // No default build, no tools — treated as standalone replacement
    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('inserts the nestable layer after tools when nestedContainers is set', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    // The uid build arg shapes the nestable layer's subuid ranges and
    // socket path (the hash already carries it through the base layer).
    expect(operations[2]).toMatch(new RegExp(`^build yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-nestable:${HASH_RE}$`))
  })

  it('layers Dockerfile.yaac on nestable (not tools) when nestedContainers is set', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(operations).toHaveLength(4)
    expect(operations[2]).toMatch(new RegExp(`^build yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`))
    expect(operations[3]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('skips the nestable layer for a standalone Dockerfile.yaac', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, true)

    // A standalone Dockerfile.yaac owns its toolchain — no canonical base,
    // tools, or nestable layers.
    expect(operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('produces an identical chain with nestedContainers off (no nestable layer)', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await loadModule()
    const result = await ensureImage('myproject', undefined, false, false)

    expect(operations).toHaveLength(2)
    expect(operations.some((op) => op.includes('nestable'))).toBe(false)
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('rejects Dockerfile.user without ARG BASE_IMAGE', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const { ensureImage } = await loadModule()
    await expect(ensureImage('myproject')).rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM \${BASE_IMAGE}`')
  })

  it('ensureImageByTag builds when image does not exist', async () => {
    const { ensureImageByTag } = await loadModule()
    await ensureImageByTag('test-img:abc', '/some/Dockerfile', '/some')
    expect(operations).toEqual(['build test-img:abc'])
  })

  it('rebuildProjectImage rebuilds tools layer with --no-cache and skips the system base', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { rebuildProjectImage } = await loadModule()
    const result = await rebuildProjectImage('myproject')

    // System base (yaac-base) is NOT rebuilt; only the tools layer runs,
    // and it runs with --no-cache so upstream installers re-execute.
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\] --no-cache$`))
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('rebuildProjectImage rebuilds the user layer downstream of tools (no --no-cache)', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { rebuildProjectImage } = await loadModule()
    const result = await rebuildProjectImage('myproject')

    // tools (--no-cache) → user. The system base is untouched.
    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\] --no-cache$`))
    expect(operations[1]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('rebuildProjectImage rejects projects with a standalone Dockerfile.yaac', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { rebuildProjectImage } = await loadModule()
    await expect(rebuildProjectImage('myproject')).rejects.toThrow(/standalone Dockerfile\.yaac/)
    expect(operations).toEqual([])
  })

  it('rebuildProjectImage forwards progress lines via onLog', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { rebuildProjectImage } = await loadModule()
    const messages: string[] = []
    await rebuildProjectImage('myproject', { onLog: (line) => messages.push(line) })

    expect(messages.some((m) => m.startsWith('removing existing image yaac-tools:'))).toBe(true)
    expect(messages.some((m) => m.startsWith('building yaac-tools:') && m.endsWith('(no cache)'))).toBe(true)
    expect(messages.some((m) => m.startsWith('done — final image is yaac-tools:'))).toBe(true)
  })

  it('resolveImageChain names each dependency step in build order', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await loadModule()
    const { layers } = await resolveImageChain('myproject', 'yaac', true)
    expect(layers.map((l) => l.name)).toEqual(['base', 'tools', 'nestable', 'project', 'user'])
  })

  it('resolveImageChain names a standalone Dockerfile.yaac as the project step', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { resolveImageChain } = await loadModule()
    const { layers } = await resolveImageChain('myproject', 'yaac')
    expect(layers.map((l) => l.name)).toEqual(['project'])
  })

  it('buildImage passes tag, dockerfile, build args, and --no-cache to podman', async () => {
    const { buildImage } = await loadModule()
    await buildImage('img:tag', '/some/Dockerfile', '/some', { K: 'v' }, { noCache: true })
    expect(operations).toEqual(['build img:tag [K=v] --no-cache'])
  })

})
