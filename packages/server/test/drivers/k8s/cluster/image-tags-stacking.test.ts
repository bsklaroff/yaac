import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from '#test/drivers/k8s/images/stacking-harness'

const PROJECT = '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f'
/** The projects' owner, whose Dockerfile.user tops each chain. */
const OWNER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'

describe('resolveImageChain', () => {
  const h = setupStackingHarness()

  it('names each dependency step in build order', async () => {
    const repoPath = path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo')
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.mkdir(path.join(h.dataDir, 'server-local', 'users', OWNER, 'build'), { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'server-local', 'users', OWNER, 'build', 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain(PROJECT, OWNER, true)
    expect(layers.map((l) => l.name)).toEqual(['base', 'tools', 'nestable', 'project', 'user'])
  })

  it('composes each step\'s tag and build args from the one above it', async () => {
    // Each layer's tag includes its parent's, and its BASE_IMAGE is the
    // parent tag. Getting either wrong silently builds on the wrong parent.
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'server-local', 'users', OWNER, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n',
    )
    await fs.writeFile(
      path.join(h.dataDir, 'server-local', 'users', OWNER, 'build', 'Dockerfile.user'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n',
    )

    const { resolveImageChain } = await h.load()
    const { layers, finalTag } = await resolveImageChain(PROJECT, OWNER, true)

    const described = layers.map((l) => {
      const args = Object.entries(l.buildArgs ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
      return `${l.tag}${args ? ` [${args}]` : ''}`
    })
    expect(described).toEqual([
      // No build args on the root layer: nothing about the building host
      // reaches an image (docs/arbitrary-uid-images.md).
      expect.stringMatching(new RegExp(`^yaac-base:${HASH_RE}$`)),
      expect.stringMatching(new RegExp(`^yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`)),
      expect.stringMatching(
        new RegExp(`^yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE}\\]$`),
      ),
      // Project layers use repos named by project id, apart from the
      // trusted chain.
      expect.stringMatching(
        new RegExp(`^yaac-proj-${PROJECT}:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`),
      ),
      expect.stringMatching(new RegExp(
        `^yaac-user-${PROJECT}:${HASH_RE} \\[BASE_IMAGE=yaac-proj-${PROJECT}:${HASH_RE}\\]$`,
      )),
    ])
    expect(finalTag).toBe(layers.at(-1)!.tag)
  })

  it('skips the shipped layers entirely for a standalone Dockerfile.yaac', async () => {
    // It replaces the base and brings its own toolchain, so neither tools
    // nor nestable applies, even with nestedContainers on.
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'FROM docker.io/ubuntu:24.04\nRUN echo custom\n',
    )

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain(PROJECT, OWNER, true)
    expect(layers.map((l) => l.name)).toEqual(['project'])
    // A standalone Dockerfile.yaac sets up its own user, so it gets no
    // build args, not even a uid.
    expect(layers[0].buildArgs).toBeUndefined()
  })

  it('treats a Dockerfile.yaac with FROM yaac-base (no ARG) as standalone', async () => {
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain(PROJECT, OWNER)
    expect(layers.map((l) => l.name)).toEqual(['project'])
  })

  it('names a standalone Dockerfile.yaac as the project step', async () => {
    const repoPath = path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo')
    const buildDir = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain(PROJECT, OWNER)
    expect(layers.map((l) => l.name)).toEqual(['project'])
  })

  it('folds build-context support files into the project and user layer tags', async () => {
    const projectBuild = path.join(h.dataDir, 'global', 'projects', PROJECT, 'config', 'build')
    const userBuild = path.join(h.dataDir, 'server-local', 'users', OWNER, 'build')
    await fs.mkdir(path.join(h.dataDir, 'global', 'projects', PROJECT, 'repo'), { recursive: true })
    await fs.mkdir(projectBuild, { recursive: true })
    await fs.mkdir(userBuild, { recursive: true })
    await fs.writeFile(path.join(projectBuild, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.writeFile(path.join(userBuild, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await h.load()
    const tagsByName = async (): Promise<Record<string, string>> => {
      const { layers } = await resolveImageChain(PROJECT, OWNER)
      return Object.fromEntries(layers.map((l) => [l.name, l.tag]))
    }

    const first = await tagsByName()
    expect(await tagsByName()).toEqual(first) // stable while nothing changes

    // A new project support file re-tags the project layer (and the user
    // layer downstream of it), but not the shared tools layer.
    await fs.writeFile(path.join(projectBuild, 'init.lua'), 'print(1)\n')
    const second = await tagsByName()
    expect(second.tools).toBe(first.tools)
    expect(second.project).not.toBe(first.project)
    expect(second.user).not.toBe(first.user)

    // A new user support file re-tags only the user layer.
    await fs.writeFile(path.join(userBuild, 'nvimrc'), 'set number\n')
    const third = await tagsByName()
    expect(third.project).toBe(second.project)
    expect(third.user).not.toBe(second.user)
  })
})
