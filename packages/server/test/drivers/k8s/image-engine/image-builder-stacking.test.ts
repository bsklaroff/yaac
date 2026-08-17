import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HASH_RE, setupStackingHarness } from './stacking-harness'

describe('resolveImageChain', () => {
  const h = setupStackingHarness()

  it('names each dependency step in build order', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n')
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(path.join(h.dataDir, 'build', 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac', true)
    expect(layers.map((l) => l.name)).toEqual(['base', 'tools', 'nestable', 'project', 'user'])
  })

  it('composes each step\'s tag and build args from the one above it', async () => {
    // The chain is a hash chain: every layer's tag folds in its parent's,
    // and the parent tag it will be built FROM is its BASE_IMAGE. Getting
    // either wrong silently produces an image built on the wrong parent.
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.mkdir(path.join(h.dataDir, 'build'), { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo custom\n',
    )
    await fs.writeFile(
      path.join(h.dataDir, 'build', 'Dockerfile.user'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user\n',
    )

    const { resolveImageChain } = await h.load()
    const { layers, finalTag } = await resolveImageChain('myproject', 'yaac', true)

    const described = layers.map((l) => {
      const args = Object.entries(l.buildArgs ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
      return `${l.tag}${args ? ` [${args}]` : ''}`
    })
    expect(described).toEqual([
      // The uid is the server's — it is what pre-creates the hostPath dirs
      // the pod writes (see podUid).
      expect.stringMatching(new RegExp(`^yaac-base:${HASH_RE} \\[YAAC_UID=\\d+\\]$`)),
      expect.stringMatching(new RegExp(`^yaac-tools:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`)),
      expect.stringMatching(
        new RegExp(`^yaac-nestable:${HASH_RE} \\[BASE_IMAGE=yaac-tools:${HASH_RE},YAAC_UID=\\d+\\]$`),
      ),
      expect.stringMatching(
        new RegExp(`^yaac-base:${HASH_RE} \\[BASE_IMAGE=yaac-nestable:${HASH_RE}\\]$`),
      ),
      expect.stringMatching(
        new RegExp(`^yaac-user-myproject:${HASH_RE} \\[BASE_IMAGE=yaac-base:${HASH_RE}\\]$`),
      ),
    ])
    expect(finalTag).toBe(layers.at(-1)!.tag)
  })

  it('skips the shipped layers entirely for a standalone Dockerfile.yaac', async () => {
    // It replaces the canonical base and owns its own toolchain, so neither
    // tools nor nestable applies — even with nestedContainers on.
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(
      path.join(buildDir, 'Dockerfile.yaac'),
      'FROM docker.io/ubuntu:24.04\nRUN echo custom\n',
    )

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac', true)
    expect(layers.map((l) => l.name)).toEqual(['project'])
    expect(layers[0].buildArgs?.YAAC_UID).toMatch(/^\d+$/)
  })

  it('treats a Dockerfile.yaac with FROM yaac-base (no ARG) as standalone', async () => {
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(path.join(h.dataDir, 'projects', 'myproject', 'repo'), { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM yaac-base\nRUN echo custom\n')

    const { resolveImageChain } = await h.load()
    const { layers } = await resolveImageChain('myproject', 'yaac')
    expect(layers.map((l) => l.name)).toEqual(['project'])
  })

  it('names a standalone Dockerfile.yaac as the project step', async () => {
    const repoPath = path.join(h.dataDir, 'projects', 'myproject', 'repo')
    const buildDir = path.join(h.dataDir, 'projects', 'myproject', 'config', 'build')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
    await fs.writeFile(path.join(buildDir, 'Dockerfile.yaac'), 'FROM docker.io/ubuntu:24.04\nRUN echo custom\n')

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
})

describe('buildImage', () => {
  const h = setupStackingHarness()

  it('passes tag, dockerfile, and build args to podman', async () => {
    const { buildImage } = await h.load()
    await buildImage('img:tag', '/some/Dockerfile', '/some', { K: 'v' })
    expect(h.operations).toEqual(['build img:tag [K=v]'])
  })

  // The build budget is idle, not total: a long build that keeps logging must
  // survive well past it, and only silence may end one.
  it('lets a build run past its idle budget as long as it keeps logging', async () => {
    h.holdBuilds()
    const { buildImage } = await h.load()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lines: string[] = []
    const build = buildImage('img:tag', '/some/Dockerfile', '/some', undefined, {
      onLog: (l) => lines.push(l),
    })
    const settled = vi.fn()
    void build.then(settled, settled)

    for (let step = 1; step <= 4; step++) {
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      h.heldBuilds[0].log(`STEP ${step}/4: RUN make`)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(settled).not.toHaveBeenCalled() // 36 minutes in, never killed
    expect(h.heldBuilds[0].signals).toEqual([])
    expect(lines).toEqual([
      'STEP 1/4: RUN make', 'STEP 2/4: RUN make', 'STEP 3/4: RUN make', 'STEP 4/4: RUN make',
    ])

    // Silence ends it — and the failure surfaces on the signal, without
    // waiting for a child that may never close (see the harness's `kill`).
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(build).rejects.toThrow('podman build produced no output for 600s')
    expect(h.heldBuilds[0].signals).toEqual(['SIGTERM'])
  })

  // The case idle cannot see: a build wedged in a retry loop keeps printing,
  // resets the clock forever, and holds the image-store lock against every
  // build behind it. The total backstop is the only thing that ends it.
  it('stops a build that is wedged but chatty at the total backstop', async () => {
    h.holdBuilds()
    const { buildImage } = await h.load()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const build = buildImage('img:tag', '/some/Dockerfile', '/some')
    const settled = vi.fn()
    void build.then(settled, settled)

    // A line every 5 minutes for just under an hour: never idle.
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      h.heldBuilds[0].log(`retrying (attempt ${i})`)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(build).rejects.toThrow('podman build still running after 3600s')
    expect(h.heldBuilds[0].signals).toEqual(['SIGTERM'])
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
