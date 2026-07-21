import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'
import { projectBuildDir, userBuildDir } from '#features/projects/build-dirs'
import {
  readProjectDockerfile,
  writeProjectDockerfile,
  readUserDockerfile,
  writeUserDockerfile,
} from '#features/projects/dockerfile'
import type { ProjectMeta } from '@yaac/shared/types'

const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'

async function writeProject(slug: string): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('readProjectDockerfile', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => { await cleanupTempDir(tmpDir) })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(readProjectDockerfile('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns empty string when the project has no Dockerfile', async () => {
    await writeProject('demo')
    expect(await readProjectDockerfile('demo')).toBe('')
  })

  it('returns the stored Dockerfile content', async () => {
    await writeProject('demo')
    await writeProjectDockerfile('demo', LAYERED)
    expect(await readProjectDockerfile('demo')).toBe(LAYERED)
  })
})

describe('writeProjectDockerfile', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => { await cleanupTempDir(tmpDir) })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(writeProjectDockerfile('missing', LAYERED)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('writes the content to config/build/Dockerfile.yaac', async () => {
    await writeProject('demo')
    await writeProjectDockerfile('demo', LAYERED)
    const raw = await fs.readFile(path.join(projectBuildDir('demo'), 'Dockerfile.yaac'), 'utf8')
    expect(raw).toBe(LAYERED)
  })

  it('accepts a standalone (non-layered) Dockerfile', async () => {
    await writeProject('demo')
    await writeProjectDockerfile('demo', 'FROM ubuntu:24.04\n')
    expect(await readProjectDockerfile('demo')).toBe('FROM ubuntu:24.04\n')
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeProject('demo')
    await writeProjectDockerfile('demo', LAYERED)
    await writeProjectDockerfile('demo', '   \n')
    expect(await readProjectDockerfile('demo')).toBe('')
    await expect(fs.access(path.join(projectBuildDir('demo'), 'Dockerfile.yaac'))).rejects.toThrow()
  })
})

describe('readUserDockerfile / writeUserDockerfile', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => { await cleanupTempDir(tmpDir) })

  it('returns empty string when unset', async () => {
    expect(await readUserDockerfile()).toBe('')
  })

  it('round-trips a layered Dockerfile', async () => {
    await writeUserDockerfile(LAYERED)
    expect(await readUserDockerfile()).toBe(LAYERED)
    const raw = await fs.readFile(path.join(userBuildDir(), 'Dockerfile.user'), 'utf8')
    expect(raw).toBe(LAYERED)
  })

  it('rejects a non-layered user Dockerfile', async () => {
    await expect(writeUserDockerfile('FROM ubuntu:24.04\n')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeUserDockerfile(LAYERED)
    await writeUserDockerfile('')
    expect(await readUserDockerfile()).toBe('')
    await expect(fs.access(path.join(userBuildDir(), 'Dockerfile.user'))).rejects.toThrow()
  })
})
