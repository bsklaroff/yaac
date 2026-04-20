import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { configOverrideDir, getProjectsDir } from '@/lib/project/paths'
import { writeConfigOverride, removeConfigOverride } from '@/lib/project/config-override'
import type { ProjectMeta } from '@/types'

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

describe('writeConfigOverride', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(writeConfigOverride('missing', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('writes the parsed config to disk and returns it', async () => {
    await writeProject('demo')
    const saved = await writeConfigOverride('demo', { envPassthrough: ['A'] })
    expect(saved).toEqual({ envPassthrough: ['A'] })
    const raw = await fs.readFile(
      path.join(configOverrideDir('demo'), 'yaac-config.json'),
      'utf8',
    )
    expect(JSON.parse(raw)).toEqual({ envPassthrough: ['A'] })
  })

  it('throws VALIDATION for malformed config', async () => {
    await writeProject('demo')
    await expect(writeConfigOverride('demo', { envPassthrough: 'not-array' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('removeConfigOverride', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(removeConfigOverride('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('removes an existing override directory', async () => {
    await writeProject('demo')
    await writeConfigOverride('demo', { envPassthrough: ['B'] })
    await removeConfigOverride('demo')
    await expect(fs.access(configOverrideDir('demo'))).rejects.toThrow()
  })

  it('is a no-op when no override exists', async () => {
    await writeProject('demo')
    await removeConfigOverride('demo')
  })
})
