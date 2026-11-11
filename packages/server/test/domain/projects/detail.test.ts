import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { getProjectDetail, assertProjectExists, resolveProjectId } from '#domain/projects'
import { ServerError } from '@yaac/shared/errors'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'
const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'

// The live workspace count comes from the driver, stubbed here. What it
// includes is asserted with each driver's `countWorkspaces`.
const count = vi.fn()

let tmpDir: string

beforeEach(async () => {
  installFakeWorkspaceDriver({ count })
  tmpDir = await createTempDataDir()
  count.mockReset().mockResolvedValue({})
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('getProjectDetail', () => {
  it('throws NOT_FOUND when the projectId is unknown', async () => {
    await expect(getProjectDetail(MISSING)).rejects.toThrow(ServerError)
    await expect(getProjectDetail(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the metadata, its repos and the live session count', async () => {
    await recordTestProject(FOO, {
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTestProject(NOPE, { repo: false })
    count.mockResolvedValue({ [FOO]: 2, bar: 1 })

    expect(await getProjectDetail(FOO)).toEqual({
      id: FOO,
      name: 'demo',
      addedAt: '2026-01-01T00:00:00.000Z',
      repos: [{ id: FOO, dir: 'demo', remoteUrl: 'https://example.com/foo', hosted: false }],
      workspaceCount: 2,
    })
    expect((await getProjectDetail(NOPE)).repos).toEqual([])
  })

  // An unreachable substrate counts zero rather than throwing, so a project
  // still renders with no cluster.
  it('renders with a zero count when the substrate has nothing to report', async () => {
    await recordTestProject(FOO, {
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })

    const detail = await getProjectDetail(FOO)
    expect(detail.workspaceCount).toBe(0)
  })
})

describe('assertProjectExists', () => {
  it('throws NOT_FOUND when the projectId is unknown', async () => {
    await expect(assertProjectExists(NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolves for a registered project', async () => {
    await recordTestProject(FOO, { remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await expect(assertProjectExists(FOO)).resolves.toBeUndefined()
  })
})

describe('resolveProjectId', () => {
  // A and B share a name and an 8-character id prefix. C's id starts with
  // D's name, and D is named after C's id.
  const A = 'abc11111-0000-4000-8000-000000000001'
  const B = 'abc11111-1111-4000-8000-000000000002'
  const C = 'cafe3333-0000-4000-8000-000000000003'
  const D = 'd4444444-0000-4000-8000-000000000004'

  beforeEach(async () => {
    await recordTestProject(A, { name: 'web' })
    await recordTestProject(B, { name: 'web' })
    await recordTestProject(C, { name: 'api' })
    await recordTestProject(D, { name: 'cafe' })
  })

  it('takes an exact id, then a name, then a unique id prefix of 8 or more', async () => {
    expect(await resolveProjectId(A)).toBe(A)
    expect(await resolveProjectId('API')).toBe(C)
    expect(await resolveProjectId('abc11111-1')).toBe(B)
    expect(await resolveProjectId('CAFE3333')).toBe(C)
  })

  it('prefers a name to an id prefix, and a full id to a name', async () => {
    expect(await resolveProjectId('cafe')).toBe(D)
    await recordTestProject('e5555555-0000-4000-8000-000000000005', { name: C })
    expect(await resolveProjectId(C)).toBe(C)
  })

  it('throws NOT_FOUND for nothing, or for a prefix shorter than 8', async () => {
    await expect(resolveProjectId('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(resolveProjectId('d444')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses blank input, and a name or prefix matching more than one, listing both', async () => {
    await expect(resolveProjectId('  ')).rejects.toMatchObject({ code: 'VALIDATION' })
    for (const ref of ['web', 'abc11111']) {
      const err = await resolveProjectId(ref).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'VALIDATION' })
      expect((err as Error).message).toContain(`web (${A})`)
      expect((err as Error).message).toContain(`web (${B})`)
    }
  })
})
