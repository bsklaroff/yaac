import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDataDir, getProjectsDir, projectConfigDir } from '@yaac/shared/project-paths'
import {
  moveLegacyUserBuildDir,
  readProjectDockerfile,
  readUserDockerfile,
  writeProjectDockerfile,
  writeUserDockerfile,
} from '#domain/projects'
import { PROJECT_DOCKERFILE, USER_DOCKERFILE } from '#lib/build-dirs'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import type { ProjectMeta } from '@yaac/shared/types'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'
const projectId = DEMO_PROJECT_ID

/** On-disk home of each Dockerfile, spelled out rather than derived: the
 *  image builder reads these exact paths as its build context. */
const projectDockerfilePath = (): string =>
  path.join(projectConfigDir(projectId), 'build', PROJECT_DOCKERFILE)
const userDockerfilePath = (userId = BUILT_IN_USER_ID): string =>
  path.join(getDataDir(), 'server-local', 'users', userId, 'build', USER_DOCKERFILE)
const OTHER_USER = 'b0b0b0b0-0000-4000-8000-000000000000'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  const dir = path.join(getProjectsDir(), projectId)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    id: projectId,
    name: 'demo',
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await recordProject(meta, BUILT_IN_USER_ID)
})

afterEach(async () => { await cleanupTempDir(tmpDir) })

describe('readProjectDockerfile', () => {
  // Whether the project EXISTS is a row question the route answers before
  // touching disk; the store read itself treats an absent file as empty.
  it('returns empty string when the project has no Dockerfile', async () => {
    expect(await readProjectDockerfile(projectId)).toBe('')
  })

  it('returns the stored Dockerfile content', async () => {
    await writeProjectDockerfile(local, projectId, LAYERED)
    expect(await readProjectDockerfile(projectId)).toBe(LAYERED)
  })
})

describe('writeProjectDockerfile', () => {
  it('writes the content to config/build/Dockerfile.yaac', async () => {
    await writeProjectDockerfile(local, projectId, LAYERED)
    expect(await fs.readFile(projectDockerfilePath(), 'utf8')).toBe(LAYERED)
  })

  it('accepts a standalone (non-layered) Dockerfile', async () => {
    await writeProjectDockerfile(local, projectId, 'FROM ubuntu:24.04\n')
    expect(await readProjectDockerfile(projectId)).toBe('FROM ubuntu:24.04\n')
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeProjectDockerfile(local, projectId, LAYERED)
    await writeProjectDockerfile(local, projectId, '   \n')
    expect(await readProjectDockerfile(projectId)).toBe('')
    await expect(fs.access(projectDockerfilePath())).rejects.toThrow()
  })
})

describe('readUserDockerfile', () => {
  it('returns empty string when unset', async () => {
    expect(await readUserDockerfile(BUILT_IN_USER_ID)).toBe('')
  })

  it('returns the content that user stored, and only theirs', async () => {
    await writeUserDockerfile(BUILT_IN_USER_ID, LAYERED)
    expect(await readUserDockerfile(BUILT_IN_USER_ID)).toBe(LAYERED)
    expect(await readUserDockerfile(OTHER_USER)).toBe('')
  })
})

describe('writeUserDockerfile', () => {
  it('writes the content to the user\'s own build dir', async () => {
    await writeUserDockerfile(OTHER_USER, LAYERED)
    expect(await fs.readFile(userDockerfilePath(OTHER_USER), 'utf8')).toBe(LAYERED)
  })

  it('rejects a standalone user Dockerfile — it must layer on the project image', async () => {
    await expect(writeUserDockerfile(BUILT_IN_USER_ID, 'FROM ubuntu:24.04\n')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(fs.access(userDockerfilePath())).rejects.toThrow()
  })

  it('removes the file when given whitespace-only content', async () => {
    await writeUserDockerfile(BUILT_IN_USER_ID, LAYERED)
    await writeUserDockerfile(BUILT_IN_USER_ID, '')
    expect(await readUserDockerfile(BUILT_IN_USER_ID)).toBe('')
    await expect(fs.access(userDockerfilePath())).rejects.toThrow()
  })
})

describe('moveLegacyUserBuildDir', () => {
  const legacyDir = (): string => path.join(getDataDir(), 'server-local', 'build')

  it('gives a single-user install\'s build dir to the built-in user, once', async () => {
    await fs.mkdir(path.join(legacyDir(), 'nvim'), { recursive: true })
    await fs.writeFile(path.join(legacyDir(), USER_DOCKERFILE), LAYERED)
    await fs.writeFile(path.join(legacyDir(), 'nvim', 'init.lua'), '-- x\n')

    await moveLegacyUserBuildDir()
    await moveLegacyUserBuildDir()

    expect(await readUserDockerfile(BUILT_IN_USER_ID)).toBe(LAYERED)
    expect(await fs.readFile(path.join(path.dirname(userDockerfilePath()), 'nvim', 'init.lua'), 'utf8')).toBe('-- x\n')
    await expect(fs.access(legacyDir())).rejects.toThrow()
  })

  it('leaves a built-in user\'s existing build dir alone', async () => {
    await writeUserDockerfile(BUILT_IN_USER_ID, LAYERED)
    await fs.mkdir(legacyDir(), { recursive: true })
    await fs.writeFile(path.join(legacyDir(), USER_DOCKERFILE), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')

    await moveLegacyUserBuildDir()

    expect(await readUserDockerfile(BUILT_IN_USER_ID)).toBe(LAYERED)
  })
})
