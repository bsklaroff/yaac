import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The session count is a cluster read; faked so the count a case asserts
// on is the one it set up, whether or not a cluster is reachable.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(),
}))

import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { projectConfigDir, getProjectsDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists } from '#features/projects'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listSessionPods)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockListPods.mockReset().mockResolvedValue([])
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
      JSON.stringify({ envPassthrough: ['B'] }),
    )
    mockListPods.mockResolvedValue([{} as SessionPod, {} as SessionPod])

    expect(await getProjectDetail('foo')).toEqual({
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
      sessionCount: 2,
      config: { envPassthrough: ['B'] },
    })
    expect(mockListPods).toHaveBeenCalledWith('foo')
  })

  it('reports a zero count rather than failing when the cluster is unavailable', async () => {
    await writeProject('foo', {
      slug: 'foo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    mockListPods.mockRejectedValue(new Error('connection refused'))

    const detail = await getProjectDetail('foo')
    expect(detail.sessionCount).toBe(0)
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
