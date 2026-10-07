/**
 * `ensureImage` over real chains: which layers it builds, and where.
 *
 * `yaac cluster install` builds the yaac-shipped layers (base/tools/
 * nestable); here they are only looked up in the registry. The remaining
 * layers build in sandboxed pods. Chain composition (tags, build args,
 * order) is asserted in image-builder-stacking.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from '#test/drivers/k8s/image-engine/stacking-harness'

const PROJECT = '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f'
/** The projects' owner, whose Dockerfile.user tops each chain. */
const OWNER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'

/** The layers `yaac cluster install` produces, by name. */
const PREBUILT = new Set(['base', 'tools', 'nestable'])

describe('ensureImage', () => {
  const h = setupStackingHarness()

  /** Put every yaac-shipped layer of this project's chain in the registry. */
  async function stagePrebuilt(
    resolveImageChain: (projectId: string, owner: string, prefix: string, nested?: boolean) => Promise<{
      layers: Array<{ name: string; tag: string }>
    }>,
    nested = false,
  ): Promise<void> {
    const { layers } = await resolveImageChain(PROJECT, OWNER, 'yaac', nested)
    h.stageRegistry(layers.filter((l) => PREBUILT.has(l.name)).map((l) => l.tag))
  }

  it('takes the yaac-shipped layers from the registry and builds only the rest', async () => {
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'server-local', 'users', OWNER, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(h.dataDir, 'server-local', 'users', OWNER, 'build', 'Dockerfile.user'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n',
    )

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain)
    const result = await ensureImage(PROJECT, OWNER)

    // base and tools are only looked up; the user layer builds in a
    // builder pod.
    expect(h.operations).toEqual([
      expect.stringMatching(
        new RegExp(`^build yaac-user-${PROJECT}:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`),
      ),
    ])
    expect(result).toMatch(new RegExp(`^yaac-user-${PROJECT}:${HASH_RE}$`))
  })

  it('needs nothing built at all when the chain is yaac-shipped end to end', async () => {
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain)
    const result = await ensureImage(PROJECT, OWNER)

    expect(h.operations).toEqual([])
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('refuses, naming the command that produces it, when a shipped layer is missing', async () => {
    // Nothing staged, as when install never ran or predates a Dockerfile
    // change. The server cannot build these, so the error names the command.
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })

    const { ensureImage } = await h.load()
    await expect(ensureImage(PROJECT, OWNER)).rejects.toThrow(/yaac cluster install/)
    expect(h.operations).toEqual([])
  })

  it('layers a project Dockerfile on nestable when nestedContainers is set', async () => {
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n',
    )

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain, true)
    await ensureImage(PROJECT, OWNER, undefined, false, true)

    // The project layer builds on nestable, not tools, so the workspace
    // image carries the in-pod container engine.
    expect(h.operations).toEqual([
      expect.stringMatching(
        new RegExp(`^build yaac-proj-${PROJECT}:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`),
      ),
    ])
  })

  it('realizes a standalone Dockerfile.yaac with no prebuilt layer at all', async () => {
    // A standalone project Dockerfile replaces the yaac-shipped chain, and
    // is untrusted, so it builds in a pod.
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'FROM docker.io/ubuntu:24.04\nRUN echo custom\n',
    )

    const { ensureImage } = await h.load()
    const result = await ensureImage(PROJECT, OWNER)

    expect(h.operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-proj-${PROJECT}:${HASH_RE}$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-proj-${PROJECT}:${HASH_RE}$`))
  })

  it('rejects Dockerfile.user without ARG BASE_IMAGE', async () => {
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'server-local', 'users', OWNER, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(h.dataDir, 'server-local', 'users', OWNER, 'build', 'Dockerfile.user'),
      'FROM yaac-current\nRUN echo user\n',
    )

    const { ensureImage } = await h.load()
    await expect(ensureImage(PROJECT, OWNER))
      .rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}`')
  })
})
