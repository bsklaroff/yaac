import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { configOverrideDir, getProjectsDir, repoDir } from '@/lib/project/paths'
import { getProjectDetail, resolveProjectConfigWithSource } from '@/lib/project/detail'
import { DaemonError } from '@/lib/daemon/errors'
import type { ProjectMeta } from '@/types'

async function writeProject(slug: string, meta: ProjectMeta): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('getProjectDetail', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the slug is unknown', async () => {
    await expect(getProjectDetail('missing')).rejects.toThrow(DaemonError)
    await expect(getProjectDetail('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the parsed metadata and null config when none exists', async () => {
    await writeProject('foo', {
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    const detail = await getProjectDetail('foo')
    expect(detail).toMatchObject({
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
      config: null,
      configSource: null,
    })
    expect(typeof detail.sessionCount).toBe('number')
  })
})

describe('resolveProjectConfigWithSource', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the slug is unknown', async () => {
    await expect(resolveProjectConfigWithSource('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns override when both override and repo configs exist', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(repoDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(repoDir('foo'), 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['A'] }),
    )
    await fs.mkdir(configOverrideDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(configOverrideDir('foo'), 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['B'] }),
    )
    const result = await resolveProjectConfigWithSource('foo')
    expect(result.source).toBe('override')
    expect(result.config).toEqual({ envPassthrough: ['B'] })
  })

  it('falls back to the repo filesystem config when no override and no git', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(repoDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(repoDir('foo'), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo hi'] }),
    )
    const result = await resolveProjectConfigWithSource('foo')
    expect(result.source).toBe('repo')
    expect(result.config).toEqual({ initCommands: ['echo hi'] })
  })

  it('returns null source when no config anywhere', async () => {
    await writeProject('empty', { slug: 'empty', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(repoDir('empty'), { recursive: true })
    const result = await resolveProjectConfigWithSource('empty')
    expect(result).toEqual({ config: null, source: null })
  })
})
