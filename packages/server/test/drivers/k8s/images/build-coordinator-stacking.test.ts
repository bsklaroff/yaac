import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from '#test/drivers/k8s/image-engine/stacking-harness'

describe('ensureImage', () => {
  const h = setupStackingHarness()

  it('builds base → tools → user when Dockerfile.user exists', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'build', 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

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
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

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
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

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
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

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
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject', undefined, false, true)

    expect(h.operations).toHaveLength(4)
    expect(h.operations[2]).toMatch(new RegExp(`^build yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`))
    expect(h.operations[3]).toMatch(new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`))
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('skips the nestable layer for a standalone Dockerfile.yaac', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

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
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'build', 'Dockerfile.user'), 'FROM yaac-current\nRUN echo user\n')

    const { ensureImage } = await h.load()
    await expect(ensureImage('myproject')).rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM \${BASE_IMAGE}`')
  })
})
