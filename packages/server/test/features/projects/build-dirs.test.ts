import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import {
  projectBuildDir,
  userBuildDir,
  resolveProjectBuildDir,
  resolveUserBuildDir,
} from '#features/projects/build-dirs'

describe('build dirs', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => { await cleanupTempDir(tmpDir) })

  it('projectBuildDir lives under the project config dir', () => {
    expect(projectBuildDir('demo')).toBe(path.join(projectConfigDir('demo'), 'build'))
  })

  it('userBuildDir lives under the data dir', () => {
    expect(userBuildDir()).toBe(path.join(getDataDir(), 'build'))
  })

  it('resolveProjectBuildDir migrates a legacy config/Dockerfile.yaac', async () => {
    const legacy = path.join(projectConfigDir('demo'), 'Dockerfile.yaac')
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, 'FROM ubuntu\n')

    const dir = await resolveProjectBuildDir('demo')

    expect(dir).toBe(projectBuildDir('demo'))
    expect(await fs.readFile(path.join(dir, 'Dockerfile.yaac'), 'utf8')).toBe('FROM ubuntu\n')
    await expect(fs.access(legacy)).rejects.toThrow()
  })

  it('resolveProjectBuildDir leaves both files alone when the target exists', async () => {
    const legacy = path.join(projectConfigDir('demo'), 'Dockerfile.yaac')
    const target = path.join(projectBuildDir('demo'), 'Dockerfile.yaac')
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(legacy, 'FROM old\n')
    await fs.writeFile(target, 'FROM new\n')

    await resolveProjectBuildDir('demo')

    expect(await fs.readFile(target, 'utf8')).toBe('FROM new\n')
    expect(await fs.readFile(legacy, 'utf8')).toBe('FROM old\n')
  })

  it('resolveProjectBuildDir does not create the dir when there is nothing to migrate', async () => {
    const dir = await resolveProjectBuildDir('demo')
    await expect(fs.access(dir)).rejects.toThrow()
  })

  it('resolveUserBuildDir migrates a legacy ~/.yaac/Dockerfile.user', async () => {
    const legacy = path.join(getDataDir(), 'Dockerfile.user')
    await fs.writeFile(legacy, 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')

    const dir = await resolveUserBuildDir()

    expect(dir).toBe(userBuildDir())
    expect(await fs.readFile(path.join(dir, 'Dockerfile.user'), 'utf8'))
      .toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')
    await expect(fs.access(legacy)).rejects.toThrow()
  })

  it('resolveUserBuildDir is a no-op without a legacy file', async () => {
    const dir = await resolveUserBuildDir()
    await expect(fs.access(dir)).rejects.toThrow()
  })
})
