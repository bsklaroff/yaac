import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { projectConfigDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists, projectRemoteUrl, resolveProjectId } from '#domain/projects'
import { ServerError } from '@yaac/shared/errors'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const EMPTY = 'a2e4822a-9833-4283-839f-7b60acf85ec9'
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

  // A malformed config must not stop a client resolving the project, which
  // `yaac config edit` does before opening that config for repair.
  it('returns the metadata and the live session count, whatever the config holds', async () => {
    await recordTestProject(FOO, {
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    await fs.mkdir(projectConfigDir(FOO), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir(FOO), 'yaac-config.json'), '{ this is not valid json')
    count.mockResolvedValue({ [FOO]: 2, bar: 1 })

    expect(await getProjectDetail(FOO)).toEqual({
      id: FOO,
      name: 'demo',
      remoteUrl: 'https://example.com/foo',
      addedAt: '2026-01-01T00:00:00.000Z',
      workspaceCount: 2,
    })
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

describe('resolveProjectConfigWithSource', () => {
  it('throws NOT_FOUND when the projectId is unknown', async () => {
    await expect(resolveProjectConfigWithSource(NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the local config when it exists', async () => {
    await recordTestProject(FOO, { remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(projectConfigDir(FOO), { recursive: true })
    await fs.writeFile(
      path.join(projectConfigDir(FOO), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['pnpm build'] }),
    )
    const result = await resolveProjectConfigWithSource(FOO)
    expect(result.config).toEqual({ initCommands: ['pnpm build'] })
  })

  it('ignores yaac-config.json checked into the cloned repo', async () => {
    await recordTestProject(FOO, { remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(repoDir(FOO), { recursive: true })
    await fs.writeFile(
      path.join(repoDir(FOO), 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo hi'] }),
    )
    const result = await resolveProjectConfigWithSource(FOO)
    expect(result.config).toBeNull()
  })

  it('returns null when no config exists', async () => {
    await recordTestProject(EMPTY, { remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    const result = await resolveProjectConfigWithSource(EMPTY)
    expect(result).toEqual({ config: null })
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

  it('resolves even when yaac-config.json is malformed', async () => {
    await recordTestProject(FOO, { remoteUrl: 'x', addedAt: '2026-01-01T00:00:00.000Z' })
    await fs.mkdir(projectConfigDir(FOO), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir(FOO), 'yaac-config.json'), '{ not json')
    await expect(assertProjectExists(FOO)).resolves.toBeUndefined()
  })
})

describe('projectRemoteUrl', () => {
  it('answers the row\'s remote, whatever the clone says, and NOT_FOUND for an unknown projectId', async () => {
    await recordTestProject(FOO, { remoteUrl: 'https://example.com/foo', addedAt: '2026-01-01T00:00:00.000Z' })
    // The clone's own origin is pod-writable and never consulted.
    await fs.mkdir(path.join(repoDir(FOO), '.git'), { recursive: true })
    await fs.writeFile(path.join(repoDir(FOO), '.git', 'config'),
      '[remote "origin"]\n\turl = https://attacker.example/x\n')

    expect(await projectRemoteUrl(FOO)).toBe('https://example.com/foo')
    await expect(projectRemoteUrl(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
