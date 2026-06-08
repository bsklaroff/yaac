import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { projectConfigDir, getProjectsDir, repoDir } from '@/lib/project/paths'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists } from '@/lib/project/detail'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta } from '@/shared/types'

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

  it('returns the local config when it exists', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(projectConfigDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(projectConfigDir('foo'), 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['B'] }),
    )
    const result = await resolveProjectConfigWithSource('foo')
    expect(result.config).toEqual({ envPassthrough: ['B'] })
  })

  it('ignores yaac-config.json checked into the cloned repo', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(repoDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(repoDir('foo'), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo hi'] }),
    )
    const result = await resolveProjectConfigWithSource('foo')
    expect(result.config).toBeNull()
  })

  it('returns null when no config exists', async () => {
    await writeProject('empty', { slug: 'empty', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    const result = await resolveProjectConfigWithSource('empty')
    expect(result).toEqual({ config: null })
  })
})

describe('assertProjectExists', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the slug is unknown', async () => {
    await expect(assertProjectExists('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolves for a registered project', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await expect(assertProjectExists('foo')).resolves.toBeUndefined()
  })

  it('resolves even when yaac-config.json is malformed', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(projectConfigDir('foo'), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir('foo'), 'yaac-config.json'), '{ not json')
    await expect(assertProjectExists('foo')).resolves.toBeUndefined()
  })
})
