import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from './stacking-harness'

describe('ensureImage', () => {
  const h = setupStackingHarness()

  it('builds base → tools → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    expect(h.operations).toHaveLength(3)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(h.operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(h.operations[2]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('builds base → tools and returns tools tag when no Dockerfile.user exists', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    expect(h.operations).toHaveLength(2)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(h.operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('uses Dockerfile.yaac instead of Dockerfile.default when present', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    // Standalone Dockerfile.yaac owns its own toolchain — no tools layer.
    expect(h.operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('layers Dockerfile.yaac on top of tools when it uses FROM ${BASE_IMAGE}', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    // base → tools → yaac (layered on tools, not on default)
    expect(h.operations).toHaveLength(3)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(h.operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    expect(h.operations[2]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('treats Dockerfile.yaac with FROM yaac-base (no ARG) as standalone', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    // No default build, no tools — treated as standalone replacement
    expect(h.operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('inserts the nestable layer after tools when nestedContainers is set', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(h.operations).toHaveLength(3)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`))
    expect(h.operations[1]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`))
    // The uid build arg shapes the nestable layer's subuid ranges and
    // socket path (the hash already carries it through the base layer).
    expect(h.operations[2]).toMatch(new RegExp(`^build yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-nestable:${HASH_RE}$`))
  })

  it('layers Dockerfile.yaac on nestable (not tools) when nestedContainers is set', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(h.operations).toHaveLength(4)
    expect(h.operations[2]).toMatch(new RegExp(`^build yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`))
    expect(h.operations[3]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('skips the nestable layer for a standalone Dockerfile.yaac', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject', undefined, false, true)

    // A standalone Dockerfile.yaac owns its toolchain — no canonical base,
    // tools, or nestable layers.
    expect(h.operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('produces an identical chain with nestedContainers off (no nestable layer)', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject', undefined, false, false)

    expect(h.operations).toHaveLength(2)
    expect(h.operations.some((op) => op.includes('nestable'))).toBe(false)
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('rejects Dockerfile.user without ARG BASE_IMAGE', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const { ensureImage } = await h.load()
    await expect(ensureImage('myproject')).rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM \${BASE_IMAGE}`')
  })
})

describe('rebuildProjectImage', () => {
  const h = setupStackingHarness()

  it('rebuilds the tools layer with --no-cache and skips the system base', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { rebuildProjectImage } = await h.load()
    const result = await rebuildProjectImage('myproject')

    // System base (yaac-base) is NOT rebuilt; only the tools layer runs,
    // and it runs with --no-cache so upstream installers re-execute.
    expect(h.operations).toHaveLength(1)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\] --no-cache$`))
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('rebuilds the user layer downstream of tools (no --no-cache)', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { rebuildProjectImage } = await h.load()
    const result = await rebuildProjectImage('myproject')

    // tools (--no-cache) → user. The system base is untouched.
    expect(h.operations).toHaveLength(2)
    expect(h.operations[0]).toMatch(new RegExp(`^build yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\] --no-cache$`))
    expect(h.operations[1]).toMatch(new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('rejects projects with a standalone Dockerfile.yaac', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { rebuildProjectImage } = await h.load()
    await expect(rebuildProjectImage('myproject')).rejects.toThrow(/standalone Dockerfile\.yaac/)
    expect(h.operations).toEqual([])
  })

  it('forwards progress lines via onLog', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })

    const { rebuildProjectImage } = await h.load()
    const messages: string[] = []
    await rebuildProjectImage('myproject', { onLog: (line) => messages.push(line) })

    expect(messages.some((m) => m.startsWith('removing existing image yaac-tools:'))).toBe(true)
    expect(messages.some((m) => m.startsWith('building yaac-tools:') && m.endsWith('(no cache)'))).toBe(true)
    expect(messages.some((m) => m.startsWith('done — final image is yaac-tools:'))).toBe(true)
  })
})
