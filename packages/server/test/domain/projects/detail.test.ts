import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { projectConfigDir, getProjectsDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists } from '#domain/projects'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

// The live worktree count comes off the substrate; stubbed so the count a
// case asserts on is the one it set up.
// The live count comes off the runtime; what it includes is asserted in
// locate.test.ts.
const count = vi.fn()

let tmpDir: string

beforeEach(async () => {
    installFakeWorktreeDriver({ countForProject: count })
  tmpDir = await createTempDataDir()
  count.mockReset().mockResolvedValue(0)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string, meta: ProjectMeta): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('getProjectDetail', () => {
  it('throws NOT_FOUND when the slug is unknown', async () => {
    await expect(getProjectDetail('missing')).rejects.toThrow(ServerError)
    await expect(getProjectDetail('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the parsed metadata, the stored config, and the live session count', async () => {
    await writeProject('foo', {
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    await fs.mkdir(projectConfigDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(projectConfigDir('foo'), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['pnpm build'] }),
    )
    count.mockResolvedValue(2)

    expect(await getProjectDetail('foo')).toEqual({
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
      worktreeCount: 2,
      config: { initCommands: ['pnpm build'] },
    })
    expect(count).toHaveBeenCalledWith('foo')
  })

  // The count answers zero for an unreachable substrate rather than throwing
  // (see locate.test.ts), so a project still renders with no cluster at all.
  it('renders with a zero count when the substrate has nothing to report', async () => {
    await writeProject('foo', {
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })

    const detail = await getProjectDetail('foo')
    expect(detail.worktreeCount).toBe(0)
    expect(detail.config).toBeNull()
  })
})

describe('resolveProjectConfigWithSource', () => {
  it('throws NOT_FOUND when the slug is unknown', async () => {
    await expect(resolveProjectConfigWithSource('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the local config when it exists', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(projectConfigDir('foo'), { recursive: true })
    await fs.writeFile(
      path.join(projectConfigDir('foo'), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['pnpm build'] }),
    )
    const result = await resolveProjectConfigWithSource('foo')
    expect(result.config).toEqual({ initCommands: ['pnpm build'] })
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
