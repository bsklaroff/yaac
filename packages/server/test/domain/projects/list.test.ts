import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'

import { listProjects } from '#domain/projects'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID } from '#db'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const BAR = '37b51d19-4a75-43e4-8b56-f6524f2d51f2'

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
    await recordTestProject(FOO, { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordTestProject(BAR, { remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    const projects = await listProjects()
    const projectIds = projects.map((p) => p.id).sort()
    expect(projectIds).toEqual([BAR, FOO])
    const foo = projects.find((p) => p.id === FOO)
    expect(foo).toMatchObject({
      id: FOO,
      name: 'demo',
      remoteUrl: 'https://example/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
      owner: BUILT_IN_USER_ID,
    })
    // A project the substrate said nothing about counts 0, not undefined.
    expect(typeof foo?.workspaceCount).toBe('number')
  })

  it('joins the live counts onto the recorded projects', async () => {
    await recordTestProject(FOO, { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordTestProject(BAR, { remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    counts.mockResolvedValue({ [FOO]: 2, [BAR]: 1 })

    const joined = Object.fromEntries((await listProjects()).map((p) => [p.id, p.workspaceCount]))
    expect(joined).toEqual({ [FOO]: 2, [BAR]: 1 })
  })

  it('still lists a project the substrate said nothing about', async () => {
    await recordTestProject(FOO, { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    counts.mockResolvedValue({})
    expect((await listProjects())[0]?.workspaceCount).toBe(0)
  })

  it('counts the recorded stops and unseen deaths', async () => {
    await recordTestProject(FOO, { remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    for (const id of ['live', 'quit', 'oom']) await recordWorkspaceCreated({ projectId: FOO, workspaceId: id })
    await recordWorkspaceStopped(FOO, 'quit')
    await recordWorkspaceStopped(FOO, 'oom', { reason: 'oom' })
    expect((await listProjects())[0]).toMatchObject({ stoppedCount: 2, unseenDeaths: 1 })
  })
})
