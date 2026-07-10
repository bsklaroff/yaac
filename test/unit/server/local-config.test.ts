import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { projectConfigDir, getProjectsDir } from '@/shared/project-paths'
import { writeProjectConfig, removeProjectConfig, readProjectConfigRaw } from '@/lib/project/local-config'
import type { ProjectMeta } from '@/shared/types'

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

  it('removes an existing config directory', async () => {
    await writeProject('demo')
    await writeProjectConfig('demo', { envPassthrough: ['B'] })
    await removeProjectConfig('demo')
    await expect(fs.access(projectConfigDir('demo'))).rejects.toThrow()
  })

  it('is a no-op when no config dir exists', async () => {
    await writeProject('demo')
    await removeProjectConfig('demo')
  })
})
