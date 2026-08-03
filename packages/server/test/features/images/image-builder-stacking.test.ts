import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setupStackingHarness } from './stacking-harness'

describe('resolveImageChain', () => {
  const h = setupStackingHarness()

  it('names each dependency step in build order', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.writeFile(path.join(h.dataDir, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac', true)
    expect(layers.map((l) => l.name)).toEqual(['base', 'tools', 'nestable', 'project', 'user'])
  })

  it('names a standalone Dockerfile.yaac as the project step', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac')
    expect(layers.map((l) => l.name)).toEqual(['project'])
  })

  it('folds build-context support files into the project and user layer tags', async () => {
    const projectBuild = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    const userBuild = path.join(h.dataDir, 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(projectBuild, { recursive: true })
    await fs.mkdir(userBuild, { recursive: true })
    await fs.writeFile(path.join(projectBuild, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.writeFile(path.join(userBuild, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await h.load()
    const tagsByName = async (): Promise<Record<string, string>> => {
      const { layers } = await resolveImageChain('myproject', 'yaac')
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

  it('serves the project Dockerfile from a legacy config/ location via migration', async () => {
    const configDir = path.join(h.dataDir, 'projects', 'myproject', 'config')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac')
    const project = layers.find((l) => l.name === 'project')
    expect(project?.dockerfile).toBe(path.join(configDir, 'build', 'Dockerfile.yaac'))
    expect(project?.context).toBe(path.join(configDir, 'build'))
    await expect(fs.access(path.join(configDir, 'Dockerfile.yaac'))).rejects.toThrow()
  })
})

describe('buildImage', () => {
  const h = setupStackingHarness()

  it('passes tag, dockerfile, build args, and --no-cache to podman', async () => {
    const { buildImage } = await h.load()
    await buildImage('img:tag', '/some/Dockerfile', '/some', { K: 'v' }, { noCache: true })
    expect(h.operations).toEqual(['build img:tag [K=v] --no-cache'])
  })
})

describe('ensureImageByTag', () => {
  const h = setupStackingHarness()

  it('builds when the image does not exist', async () => {
    const { ensureImageByTag } = await h.load()
    await ensureImageByTag('test-img:abc', '/some/Dockerfile', '/some')
    expect(h.operations).toEqual(['build test-img:abc'])
  })
})
