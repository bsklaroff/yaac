import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'

import { listProjects } from '#features/projects'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import type { ProjectMeta } from '@yaac/shared/types'

// Which projects exist is the server's own record; how many workspaces each
// is running is the herd's, and what that count excludes (spares, unlabelled
// pods) is asserted in test/herd/.
const counts = vi.fn<() => Promise<Record<string, number>>>()

async function writeProject(slug: string, meta: ProjectMeta): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('listProjects', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    counts.mockReset().mockResolvedValue({})
    _setHerdForTests({ workspaces: { counts } })
  })

  afterEach(async () => {
    _resetHerdForTests()
    await cleanupTempDir(tmpDir)
  })

  it('returns [] when the projects dir does not exist', async () => {
    // createTempDataDir already mkdir's projects/, so simulate "missing"
    // by removing it.
    await fs.rm(getProjectsDir(), { recursive: true, force: true })
    expect(await listProjects()).toEqual([])
  })

  it('returns the parsed project metadata', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await writeProject('bar', { slug: 'bar', remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    const projects = await listProjects()
    const slugs = projects.map((p) => p.slug).sort()
    expect(slugs).toEqual(['bar', 'foo'])
    const foo = projects.find((p) => p.slug === 'foo')
    expect(foo).toMatchObject({
      slug: 'foo',
      remoteUrl: 'https://example/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    // A project the herd said nothing about counts 0, not undefined.
    expect(typeof foo?.worktreeCount).toBe('number')
  })

  it('joins the herd’s counts onto the recorded projects', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await writeProject('bar', { slug: 'bar', remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    counts.mockResolvedValue({ foo: 2, bar: 1 })

    const joined = Object.fromEntries((await listProjects()).map((p) => [p.slug, p.worktreeCount]))
    expect(joined).toEqual({ foo: 2, bar: 1 })
  })

  // The whole point of the split: which projects exist is a row, so a herd
  // with nothing to say costs the listing a count, not the project.
  it('still lists a project the herd said nothing about', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    counts.mockResolvedValue({})
    expect((await listProjects())[0]?.worktreeCount).toBe(0)
  })

  it('skips entries with malformed project.json', async () => {
    await writeProject('good', { slug: 'good', remoteUrl: 'https://example/good', addedAt: '2026-01-01T00:00:00.000Z' })
    const badDir = path.join(getProjectsDir(), 'bad')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'project.json'), 'not json')
    const projects = await listProjects()
    expect(projects.map((p) => p.slug)).toEqual(['good'])
  })
})
