import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
  }
})

import { LABEL_PREWARMED, listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { listProjects } from '#features/projects'
import {
  _resetDeferredClusterBootForTests,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
} from '#platform/k8s/deferred-boot'
import type { ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listSessionPods)

function pod(projectSlug: string, opts: { prewarmed?: boolean } = {}): SessionPod {
  return {
    jobName: `yaac-${projectSlug}-1`,
    podName: `yaac-${projectSlug}-1-abcde`,
    sessionId: '1',
    projectSlug,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: opts.prewarmed ? { [LABEL_PREWARMED]: 'true' } : {},
  }
}

async function writeProject(slug: string, meta: ProjectMeta): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('listProjects', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetDeferredClusterBootForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    _resetDeferredClusterBootForTests()
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

  it('counts live session pods per project, ignoring spares and unlabelled pods', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    await writeProject('bar', { slug: 'bar', remoteUrl: 'https://example/bar', addedAt: '2026-01-02T00:00:00.000Z' })
    mockListPods.mockResolvedValue([
      pod('foo'),
      pod('foo'),
      pod('bar'),
      pod('bar', { prewarmed: true }), // a spare is not a user session
      pod(''), // no project label at all
    ])

    const counts = Object.fromEntries((await listProjects()).map((p) => [p.slug, p.sessionCount]))
    expect(counts).toEqual({ foo: 2, bar: 1 })
  })

  it('reports zero counts when the cluster is unavailable', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    mockListPods.mockRejectedValue(new Error('connection refused'))
    expect((await listProjects())[0]?.sessionCount).toBe(0)
  })

  it('answers with zero counts and no cluster call while the deferred boot is pending', async () => {
    await writeProject('foo', { slug: 'foo', remoteUrl: 'https://example/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)

    const projects = await listProjects()
    expect(projects.map((p) => p.slug)).toEqual(['foo'])
    expect(projects[0]?.sessionCount).toBe(0)
    expect(mockListPods).not.toHaveBeenCalled()

    // The short-circuit still fires the attach — it just doesn't wait.
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
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
