import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectConfigDir, getProjectsDir } from '@yaac/shared/project-paths'
import { writeProjectConfig, removeProjectConfig, readProjectConfigRaw } from '#lib/project/local-config'
import type { ProjectMeta } from '@yaac/shared/types'

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

describe('writeProjectConfig', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(writeProjectConfig('missing', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('writes the parsed config to disk and returns it', async () => {
    await writeProject('demo')
    const saved = await writeProjectConfig('demo', { envPassthrough: ['A'] })
    expect(saved).toEqual({ envPassthrough: ['A'] })
    const raw = await fs.readFile(
      path.join(projectConfigDir('demo'), 'yaac-config.json'),
      'utf8',
    )
    expect(JSON.parse(raw)).toEqual({ envPassthrough: ['A'] })
  })

  it('throws VALIDATION for malformed config', async () => {
    await writeProject('demo')
    await expect(writeProjectConfig('demo', { envPassthrough: 'not-array' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('readProjectConfigRaw', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(readProjectConfigRaw('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("returns '' when the project has no config file", async () => {
    await writeProject('demo')
    expect(await readProjectConfigRaw('demo')).toBe('')
  })

  it('returns malformed content verbatim (the repair flow depends on it)', async () => {
    await writeProject('demo')
    const dir = projectConfigDir('demo')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'yaac-config.json'), '{ broken')
    expect(await readProjectConfigRaw('demo')).toBe('{ broken')
  })
})

describe('removeProjectConfig', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(removeProjectConfig('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('removes only yaac-config.json, keeping the rest of the config dir', async () => {
    await writeProject('demo')
    await writeProjectConfig('demo', { envPassthrough: ['B'] })
    const dockerfile = path.join(projectConfigDir('demo'), 'build', 'Dockerfile.yaac')
    await fs.mkdir(path.dirname(dockerfile), { recursive: true })
    await fs.writeFile(dockerfile, 'FROM ubuntu\n')

    await removeProjectConfig('demo')

    await expect(fs.access(path.join(projectConfigDir('demo'), 'yaac-config.json'))).rejects.toThrow()
    expect(await fs.readFile(dockerfile, 'utf8')).toBe('FROM ubuntu\n')
  })

  it('is a no-op when no config dir exists', async () => {
    await writeProject('demo')
    await removeProjectConfig('demo')
  })
})
