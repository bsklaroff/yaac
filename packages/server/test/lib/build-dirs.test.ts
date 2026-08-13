import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import { projectBuildDir, userBuildDir } from '#lib/build-dirs'

let tmpDir: string
beforeEach(async () => { tmpDir = await createTempDataDir() })
afterEach(async () => { await cleanupTempDir(tmpDir) })

describe('projectBuildDir', () => {
  it('is config/build/, and naming it does not create it', async () => {
    const dir = projectBuildDir('demo')
    expect(dir).toBe(path.join(projectConfigDir('demo'), 'build'))
    await expect(fs.access(dir)).rejects.toThrow()
  })
})

describe('userBuildDir', () => {
  it('is ~/.yaac/build/, and naming it does not create it', async () => {
    const dir = userBuildDir()
    expect(dir).toBe(path.join(getDataDir(), 'build'))
    await expect(fs.access(dir)).rejects.toThrow()
  })
})
