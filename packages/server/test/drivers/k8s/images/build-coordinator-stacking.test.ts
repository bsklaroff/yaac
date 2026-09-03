/**
 * `ensureImage` over real chains: which layers it realizes, and where each
 * one comes from.
 *
 * The split it enforces is the whole point. The yaac-shipped layers
 * (base/tools/nestable) are built by `yaac cluster install` on the CLI
 * machine and only ever LOOKED UP here — so a chain is realizable exactly
 * when the registry already holds them, and the rest of it builds in
 * sandboxed pods. Chain composition itself (tags, build args, order) is
 * `resolveImageChain`'s, and is asserted in image-builder-stacking.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from '#test/drivers/k8s/image-engine/stacking-harness'

/** The layers `yaac cluster install` produces, by name. */
const PREBUILT = new Set(['base', 'tools', 'nestable'])

describe('ensureImage', () => {
  const h = setupStackingHarness()

  /** Put every yaac-shipped layer of this project's chain in the registry. */
  async function stagePrebuilt(
    resolveImageChain: (slug: string, prefix: string, nested?: boolean) => Promise<{
      layers: Array<{ name: string; tag: string }>
    }>,
    slug: string,
    nested = false,
  ): Promise<void> {
    const { layers } = await resolveImageChain(slug, 'yaac', nested)
    h.stageRegistry(layers.filter((l) => PREBUILT.has(l.name)).map((l) => l.tag))
  }

  it('takes the yaac-shipped layers from the registry and builds only the rest', async () => {
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(h.dataDir, 'build', 'Dockerfile.user'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n',
    )

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain, 'myproject')
    const result = await ensureImage('myproject')

    // base and tools cost a registry HEAD each; only the user layer — which
    // runs a Dockerfile the user wrote — is realized, and in a builder pod.
    expect(h.operations).toEqual([
      expect.stringMatching(
        new RegExp(`^build yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`),
      ),
    ])
    expect(result).toMatch(new RegExp(`^yaac-user-myproject:${HASH_RE}$`))
  })

  it('needs nothing built at all when the chain is yaac-shipped end to end', async () => {
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain, 'myproject')
    const result = await ensureImage('myproject')

    expect(h.operations).toEqual([])
    expect(result).toMatch(new RegExp(`^yaac-tools:${HASH_RE}$`))
  })

  it('refuses, naming the command that produces it, when a shipped layer is missing', async () => {
    // Nothing staged: this is a machine whose install never ran, or ran
    // before the Dockerfiles changed. Building it here would put a
    // container engine back on the server's critical path, so the only
    // useful answer is which command produces the tag.
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })

    const { ensureImage } = await h.load()
    await expect(ensureImage('myproject')).rejects.toThrow(/yaac cluster install/)
    expect(h.operations).toEqual([])
  })

  it('layers a project Dockerfile on nestable when nestedContainers is set', async () => {
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n',
    )

    const { ensureImage, resolveImageChain } = await h.load()
    await stagePrebuilt(resolveImageChain, 'myproject', true)
    await ensureImage('myproject', undefined, false, true)

    // The project layer's parent is the nestable tag, not tools — that is
    // what carries the in-pod engine into the image the session runs.
    expect(h.operations).toEqual([
      expect.stringMatching(
        new RegExp(`^build yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`),
      ),
    ])
  })

  it('realizes a standalone Dockerfile.yaac with no prebuilt layer at all', async () => {
    // A standalone project Dockerfile replaces the yaac-shipped chain, so
    // there is nothing for the install to have produced — and it is still
    // untrusted, so it still builds in a pod.
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'FROM docker.io/ubuntu:24.04\nRUN echo custom\n',
    )

    const { ensureImage } = await h.load()
    const result = await ensureImage('myproject')

    expect(h.operations).toEqual([
      expect.stringMatching(new RegExp(`^build yaac-base:${HASH_RE}$`)),
    ])
    expect(result).toMatch(new RegExp(`^yaac-base:${HASH_RE}$`))
  })

  it('rejects Dockerfile.user without ARG BASE_IMAGE', async () => {
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(h.dataDir, 'build', 'Dockerfile.user'),
      'FROM yaac-current\nRUN echo user\n',
    )

    const { ensureImage } = await h.load()
    await expect(ensureImage('myproject'))
      .rejects.toThrow('must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}`')
  })
})
