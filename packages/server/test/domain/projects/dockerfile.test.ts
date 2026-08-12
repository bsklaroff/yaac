import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDataDir, getProjectsDir, projectConfigDir } from '@yaac/shared/project-paths'
import { readProjectDockerfile, readUserDockerfile, writeProjectDockerfile, writeUserDockerfile } from '#domain/projects'
import { PROJECT_DOCKERFILE, USER_DOCKERFILE } from '#lib/build-dirs'
import type { ProjectMeta } from '@yaac/shared/types'

const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'
const slug = 'demo'

/** On-disk home of each Dockerfile, spelled out rather than derived: the
 *  image builder reads these exact paths as its build context. */
const projectDockerfilePath = (): string =>
  path.join(projectConfigDir(slug), 'build', PROJECT_DOCKERFILE)
const userDockerfilePath = (): string =>
  path.join(getDataDir(), 'build', USER_DOCKERFILE)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
})

afterEach(async () => { await cleanupTempDir(tmpDir) })

describe('readProjectDockerfile', () => {
  // Whether the project EXISTS is a row question the route answers before
  // touching disk; the store read itself treats an absent file as empty.
  it('returns empty string when the project has no Dockerfile', async () => {
    expect(await readProjectDockerfile(slug)).toBe('')
  })

  it('returns the stored Dockerfile content', async () => {
    await writeProjectDockerfile(slug, LAYERED)
    expect(await readProjectDockerfile(slug)).toBe(LAYERED)
  })
})

describe('writeProjectDockerfile', () => {
  it('writes the content to config/build/Dockerfile.yaac', async () => {
    await writeProjectDockerfile(slug, LAYERED)
    expect(await fs.readFile(projectDockerfilePath(), 'utf8')).toBe(LAYERED)
  })

  it('accepts a standalone (non-layered) Dockerfile', async () => {
    await writeProjectDockerfile(slug, 'FROM ubuntu:24.04\n')
    expect(await readProjectDockerfile(slug)).toBe('FROM ubuntu:24.04\n')
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeProjectDockerfile(slug, LAYERED)
    await writeProjectDockerfile(slug, '   \n')
    expect(await readProjectDockerfile(slug)).toBe('')
    await expect(fs.access(projectDockerfilePath())).rejects.toThrow()
  })
})

describe('readUserDockerfile', () => {
  it('returns empty string when unset', async () => {
    expect(await readUserDockerfile()).toBe('')
  })

  it('returns the stored content', async () => {
    await writeUserDockerfile(LAYERED)
    expect(await readUserDockerfile()).toBe(LAYERED)
  })
})

describe('writeUserDockerfile', () => {
  it('writes the content to ~/.yaac/build/Dockerfile.user', async () => {
    await writeUserDockerfile(LAYERED)
    expect(await fs.readFile(userDockerfilePath(), 'utf8')).toBe(LAYERED)
  })

  it('rejects a standalone user Dockerfile — it must layer on the project image', async () => {
    await expect(writeUserDockerfile('FROM ubuntu:24.04\n')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(fs.access(userDockerfilePath())).rejects.toThrow()
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeUserDockerfile(LAYERED)
    await writeUserDockerfile('')
    expect(await readUserDockerfile()).toBe('')
    await expect(fs.access(userDockerfilePath())).rejects.toThrow()
  })
})
