import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

describe('ensureImage layer stacking', () => {
  let dataDir: string
  const operations: string[] = []
  const runArgs: string[][] = []

  beforeEach(async () => {
    operations.length = 0
    runArgs.length = 0
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
        if (args[0] === 'run') {
          operations.push(`run-setup ${args[args.indexOf('--name') + 1]}`)
          runArgs.push(args)
          cb(null, { stdout: '', stderr: '' })
          return
        }
        if (args[0] === 'commit') {
          const imageName = args[args.length - 1]
          operations.push(`commit ${imageName}`)
          cb(null, { stdout: '', stderr: '' })
          return
        }
        if (args[0] === 'rm') {
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
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-default\nRUN echo user\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      'build yaac-default',
      'tag yaac-default → yaac-current',
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
      'build yaac-default',
      'tag yaac-default → yaac-current',
      'tag yaac-default → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('uses Dockerfile.yaac instead of Dockerfile.default when present', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toEqual([
      'build yaac-default',
      'tag yaac-default → yaac-current',
      'tag yaac-default → yaac-user-myproject',
    ])
    expect(result).toBe('yaac-user-myproject')
  })

  it('runs yaac-setup.sh and commits cached image when script exists', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(repoPath, 'yaac-setup.sh'), '#!/bin/bash\necho setup\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations[0]).toBe('build yaac-default')
    expect(operations).toContainEqual(expect.stringContaining('run-setup'))
    expect(operations).toContainEqual(expect.stringContaining('commit yaac-setup-myproject'))
    expect(result).toBe('yaac-user-myproject')
  })

  it('builds full chain: Dockerfile.yaac + yaac-setup.sh + Dockerfile.user', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')
    await fs.writeFile(path.join(repoPath, 'yaac-setup.sh'), '#!/bin/bash\necho setup\n')
    await fs.writeFile(path.join(dataDir, 'Dockerfile.user'), 'FROM yaac-setup\nRUN echo user\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations[0]).toBe('build yaac-default')
    expect(operations).toContainEqual(expect.stringContaining('run-setup'))
    expect(operations).toContainEqual(expect.stringContaining('commit yaac-setup-myproject'))
    expect(operations).toContainEqual('build yaac-user-myproject')
    expect(result).toBe('yaac-user-myproject')
  })

  it('prefers local yaac-setup.sh over repo yaac-setup.sh', async () => {
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(repoPath, 'yaac-setup.sh'), '#!/bin/bash\necho repo-setup\n')
    await fs.writeFile(path.join(overrideDir, 'yaac-setup.sh'), '#!/bin/bash\necho local-setup\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toContainEqual(expect.stringContaining('run-setup'))
    expect(operations).toContainEqual(expect.stringContaining('commit yaac-setup-myproject'))
    expect(result).toBe('yaac-user-myproject')
  })

  it('runs setup script from /workspace with working dir set', async () => {
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(repoPath, 'yaac-setup.sh'), '#!/bin/bash\necho setup\n')

    const ensureImage = await loadEnsureImage()
    await ensureImage('myproject')

    expect(runArgs).toHaveLength(1)
    const args = runArgs[0]
    // Script is mounted and executed at /workspace/yaac-setup.sh
    expect(args[args.length - 1]).toBe('/workspace/yaac-setup.sh')
    // Working directory is set to /workspace
    const wIdx = args.indexOf('-w')
    expect(wIdx).toBeGreaterThan(-1)
    expect(args[wIdx + 1]).toBe('/workspace')
  })

  it('mounts local override script into /workspace/yaac-setup.sh', async () => {
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'yaac-setup.sh'), '#!/bin/bash\necho override\n')

    const ensureImage = await loadEnsureImage()
    await ensureImage('myproject')

    expect(runArgs).toHaveLength(1)
    const args = runArgs[0]
    // Override script is bind-mounted at /workspace/yaac-setup.sh
    const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === '-v')
    const scriptMount = vFlags.find((v) => v.includes('/workspace/yaac-setup.sh'))
    expect(scriptMount).toBeDefined()
    expect(scriptMount).toContain(path.join(overrideDir, 'yaac-setup.sh'))
    // Executed from /workspace
    expect(args[args.length - 1]).toBe('/workspace/yaac-setup.sh')
    const wIdx = args.indexOf('-w')
    expect(wIdx).toBeGreaterThan(-1)
    expect(args[wIdx + 1]).toBe('/workspace')
  })

  it('uses local yaac-setup.sh when repo has none', async () => {
    const overrideDir = path.join(dataDir, 'projects', 'myproject', 'config-override')
    const repoPath = path.join(dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(overrideDir, { recursive: true })
    await fs.writeFile(path.join(overrideDir, 'yaac-setup.sh'), '#!/bin/bash\necho local-only\n')

    const ensureImage = await loadEnsureImage()
    const result = await ensureImage('myproject')

    expect(operations).toContainEqual(expect.stringContaining('run-setup'))
    expect(operations).toContainEqual(expect.stringContaining('commit yaac-setup-myproject'))
    expect(result).toBe('yaac-user-myproject')
  })
})
