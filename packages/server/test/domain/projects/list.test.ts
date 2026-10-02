import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'

import { listProjects } from '#domain/projects'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

// Projects come from the DB; per-project workspace counts come from the
// driver, stubbed here. What a count excludes (spares, unlabelled pods) is
// asserted in test/drivers/k8s/workspaces/locate.test.ts.
const counts = vi.fn()

describe('listProjects', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorkspaceDriver({ count: counts })
    tmpDir = await createTempDataDir()
    counts.mockReset().mockResolvedValue({})
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
    await recordTestProject('foo', { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordTestProject('bar', { remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    const projects = await listProjects()
    const slugs = projects.map((p) => p.slug).sort()
    expect(slugs).toEqual(['bar', 'foo'])
    const foo = projects.find((p) => p.slug === 'foo')
    expect(foo).toMatchObject({
      slug: 'foo',
      remoteUrl: 'https://example/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    // A project the substrate said nothing about counts 0, not undefined.
    expect(typeof foo?.workspaceCount).toBe('number')
  })

  it('joins the live counts onto the recorded projects', async () => {
    await recordTestProject('foo', { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordTestProject('bar', { remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    counts.mockResolvedValue({ foo: 2, bar: 1 })

    const joined = Object.fromEntries((await listProjects()).map((p) => [p.slug, p.workspaceCount]))
    expect(joined).toEqual({ foo: 2, bar: 1 })
  })

  it('still lists a project the substrate said nothing about', async () => {
    await recordTestProject('foo', { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    counts.mockResolvedValue({})
    expect((await listProjects())[0]?.workspaceCount).toBe(0)
  })
})
