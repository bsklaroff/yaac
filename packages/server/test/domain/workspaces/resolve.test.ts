import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { BUILT_IN_USER_ID } from '#db'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import {
  resolveWorkspace,
  resolveWorkspaceContainer,
  resolveWorkspaceId,
  resolveWorkspaceRecord,
} from '#domain/workspaces/resolve'
import { ServerError } from '@yaac/shared/errors'
import type { RuntimeHandle } from '#drivers/contract'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

/**
 * The driver's `find` is faked. Which workspace an id names and whether it
 * runs is tested in test/drivers/k8s/workspaces/locate.test.ts; these tests
 * cover the errors the routes rely on.
 */
const find = vi.fn()

function handle(over: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    workspaceId: 'abc123def456',
    projectId: PROJ,
    jobName: 'yaac-proj-abc123',
    tool: 'claude',
    mode: 'tui',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 0,
    prewarmed: false,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
    ...over,
  }
}

describe('resolveWorkspaceContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorkspaceDriver({ find })
    tmpDir = await createTempDataDir()
    find.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when no workspace matches the id', async () => {
    await expect(resolveWorkspaceContainer('nope')).rejects.toBeInstanceOf(ServerError)
    await expect(resolveWorkspaceContainer('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws NOT_FOUND for an unknown id regardless of requireRunning', async () => {
    await expect(
      resolveWorkspaceContainer('nope', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // Several polled endpoints resolve through here, so the lookup prefers the
  // cache over a subprocess. Prefixes are expanded over rows first, so the
  // driver only sees exact ids.
  it('asks for the cache-preferred match by exact id and returns the container', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'abc123def456' })
    find.mockResolvedValue(handle())
    expect(await resolveWorkspaceContainer('abc123', { requireRunning: true })).toEqual({
      jobName: 'yaac-proj-abc123',
      workspaceId: 'abc123def456',
      projectId: PROJ,
      state: 'running',
    })
    expect(find).toHaveBeenCalledWith('abc123def456', { preferCache: true })
  })

  // WebSocket attaches hold full ids, so they get no prefix expansion.
  it('hands an exact-only input to the driver untouched', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'abc123def456' })
    await expect(resolveWorkspaceContainer('abc123', { exact: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(find).toHaveBeenCalledWith('abc123', { preferCache: true })
  })

  it('reports a non-running workspace as CONFLICT only when the caller requires running', async () => {
    find.mockResolvedValue(handle({ running: false, state: 'pending' }))
    await expect(
      resolveWorkspaceContainer('abc123', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await resolveWorkspaceContainer('abc123')).toMatchObject({ state: 'pending' })
  })

  // A non-owner is refused alike whether or not the workspace runs, so the
  // row answers before the substrate is asked.
  it('refuses an actor who does not own the workspace\'s project', async () => {
    await recordTestProject(PROJ)
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'abc123def456' })
    const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
    const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: OTHER } as const
    find.mockRejectedValue(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused'))
    await expect(resolveWorkspaceContainer('abc123', { requireRunning: true, owner: teammate }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(find).not.toHaveBeenCalled()

    // A unit with no row is checked once found.
    find.mockResolvedValue(handle({ workspaceId: 'unrecorded' }))
    await expect(resolveWorkspaceContainer('unrecorded', { exact: true, owner: teammate }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await resolveWorkspaceContainer('unrecorded', { exact: true, owner })).toMatchObject({ projectId: PROJ })
  })

  // "Could not ask" must not become a NOT_FOUND the client would act on.
  it('lets a substrate failure through', async () => {
    find.mockRejectedValue(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused'))
    await expect(resolveWorkspaceContainer('abc123')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})

/**
 * For readers of recorded state: the row answers when the substrate does
 * not, so a stopped workspace resolves even with the substrate down.
 */
describe('resolveWorkspaceRecord', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorkspaceDriver({ find })
    tmpDir = await createTempDataDir()
    find.mockReset().mockResolvedValue(undefined)
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'abc123def456' })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // Callers that read from inside the container need the job and tool,
  // which only a live match has.
  it('carries the running workspace through when there is one', async () => {
    find.mockResolvedValue(handle())
    expect(await resolveWorkspaceRecord('abc123')).toEqual({
      workspaceId: 'abc123def456',
      projectId: PROJ,
      jobName: 'yaac-proj-abc123',
      tool: 'claude',
    })
  })

  it.each([
    ['the workspace is gone', undefined],
    ['the substrate cannot be asked', new ServerError('RUNTIME_UNAVAILABLE', 'refused')],
  ])('falls back to the row when %s', async (_case, outcome) => {
    if (outcome instanceof Error) find.mockRejectedValue(outcome)
    else find.mockResolvedValue(outcome)

    expect(await resolveWorkspaceRecord('abc123')).toEqual({
      workspaceId: 'abc123def456',
      projectId: PROJ,
    })
  })

  it('throws NOT_FOUND when neither the substrate nor the rows know the id', async () => {
    await expect(resolveWorkspaceRecord('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resolveWorkspace', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    for (const [projectId, workspaceId] of [
      [PROJ, 'abc'],
      [PROJ, 'abcdef-1'],
      [PROJ, 'abcdef-2'],
      [PROJ, 'feed-1'],
      [OTHER, 'fe11-2'],
    ]) await recordWorkspaceCreated({ projectId, workspaceId })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'spare-1', spare: true })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('resolves an exact id ahead of the longer ids it prefixes, and a unique prefix', async () => {
    expect(await resolveWorkspace(' abc ')).toEqual({ ok: true, workspaceId: 'abc' })
    expect(await resolveWorkspace('feed')).toEqual({ ok: true, workspaceId: 'feed-1' })
  })

  it('reports an ambiguous prefix, within a project or across them', async () => {
    expect(await resolveWorkspace('abcdef')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(await resolveWorkspace('fe')).toEqual({ ok: false, reason: 'ambiguous' })
    // Scoped to a project, other projects' rows are ignored.
    expect(await resolveWorkspace('fe', { projectId: PROJ })).toEqual({ ok: true, workspaceId: 'feed-1' })
    expect(await resolveWorkspace('fe11-2', { projectId: PROJ })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('finds nothing for an empty input or an unclaimed spare, even by its exact id', async () => {
    expect(await resolveWorkspace('  ')).toEqual({ ok: false, reason: 'not-found' })
    expect(await resolveWorkspace('spare-1')).toEqual({ ok: false, reason: 'not-found' })
    expect(await resolveWorkspace('nope')).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('resolveWorkspaceId', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'abcdef-1' })
    await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'abcdef-2' })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('expands a unique prefix, and refuses an empty or ambiguous input before any driver sees it', async () => {
    expect(await resolveWorkspaceId('abcdef-1')).toBe('abcdef-1')
    expect(await resolveWorkspaceId('abcdef-2')).toBe('abcdef-2')
    await expect(resolveWorkspaceId('')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(resolveWorkspaceId('abcdef')).rejects.toMatchObject({
      code: 'VALIDATION', message: expect.stringContaining('Ambiguous') as string,
    })
  })

  // A workspace with no row (e.g. after a DB reset) is still reachable by
  // its full id.
  it('passes an id no row knows through as-is', async () => {
    expect(await resolveWorkspaceId('unrecorded-id')).toBe('unrecorded-id')
  })
})
