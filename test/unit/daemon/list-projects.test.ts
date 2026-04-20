import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { getProjectsDir } from '@/lib/project/paths'
import { listProjects } from '@/lib/project/list'
import type { ProjectMeta } from '@/types'

async function writeProject(slug: string, meta: ProjectMeta): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('listProjects', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
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
    // Without podman the count is 0, not undefined.
    expect(typeof foo?.sessionCount).toBe('number')
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
