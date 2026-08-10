import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import { PROJECT_DOCKERFILE, USER_DOCKERFILE, resolveProjectBuildDir, resolveUserBuildDir } from '#store/projects'

let tmpDir: string
beforeEach(async () => { tmpDir = await createTempDataDir() })
afterEach(async () => { await cleanupTempDir(tmpDir) })

describe('resolveProjectBuildDir', () => {
  it('is config/build/, and migrates a legacy config/Dockerfile.yaac into it', async () => {
    const legacy = path.join(projectConfigDir('demo'), PROJECT_DOCKERFILE)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, 'FROM ubuntu\n')

    const dir = await resolveProjectBuildDir('demo')

    expect(dir).toBe(path.join(projectConfigDir('demo'), 'build'))
    expect(await fs.readFile(path.join(dir, PROJECT_DOCKERFILE), 'utf8')).toBe('FROM ubuntu\n')
    await expect(fs.access(legacy)).rejects.toThrow()
  })

  it('leaves both files alone when the target already exists', async () => {
    const legacy = path.join(projectConfigDir('demo'), PROJECT_DOCKERFILE)
    const target = path.join(projectConfigDir('demo'), 'build', PROJECT_DOCKERFILE)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(legacy, 'FROM old\n')
    await fs.writeFile(target, 'FROM new\n')

    await resolveProjectBuildDir('demo')

    expect(await fs.readFile(target, 'utf8')).toBe('FROM new\n')
    expect(await fs.readFile(legacy, 'utf8')).toBe('FROM old\n')
  })

  it('does not create the dir when there is nothing to migrate', async () => {
    const dir = await resolveProjectBuildDir('demo')
    await expect(fs.access(dir)).rejects.toThrow()
  })
})

describe('resolveUserBuildDir', () => {
  it('is ~/.yaac/build/, and migrates a legacy ~/.yaac/Dockerfile.user into it', async () => {
    const legacy = path.join(getDataDir(), USER_DOCKERFILE)
    await fs.writeFile(legacy, 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')

    const dir = await resolveUserBuildDir()

    expect(dir).toBe(path.join(getDataDir(), 'build'))
    expect(await fs.readFile(path.join(dir, USER_DOCKERFILE), 'utf8'))
      .toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')
    await expect(fs.access(legacy)).rejects.toThrow()
  })

  it('is a no-op without a legacy file', async () => {
    const dir = await resolveUserBuildDir()
    await expect(fs.access(dir)).rejects.toThrow()
  })
})
