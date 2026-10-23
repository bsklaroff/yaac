import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import {
  previewWorkspaceRetention,
  queueWorkspace,
  reconcileWorkspaceRetention,
  setWorkspaceRetention,
} from '#domain/workspaces'
import { getProjectRow, getWorkspaceRow, setProjectWorkspaceRetention, BUILT_IN_USER_ID } from '#db'
import { recordWorkspaceCreated, recordWorkspaceLife, recordWorkspaceStopped } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { recordTestProject, seedProject } from '@yaac/test-utils/project-fixture'
import { workspaceDir } from '@yaac/shared/project-paths'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: 'b0b0b0b0-0000-4000-8000-000000000000' } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const DAY_MS = 24 * 60 * 60_000
const ALL = ['wt-old', 'wt-old-parent', 'wt-ran-since', 'wt-recent', 'wt-running']
const running = new AbortController().signal

let tmpDir: string

/**
 * Two projects as of "now", where PROJ holds:
 *  - wt-old, stopped 10 days ago;
 *  - wt-old-parent, the same, with an entry queued after it, so its delete
 *    is refused;
 *  - wt-ran-since, stopped 10 days ago, restarted without the stop being
 *    cleared (a lost write), run for 8 days and stopped 2 days ago;
 *  - wt-recent, stopped 2 days ago;
 *  - wt-running, never stopped;
 * and OTHER holds wt-other-old, stopped 10 days ago.
 */
beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  await recordTestProject(OTHER)
  installFakeWorkspaceDriver({ findForTeardown: () => Promise.resolve(undefined) })
  vi.useFakeTimers({ toFake: ['Date'] })
  const now = Date.now()
  vi.setSystemTime(now - 10 * DAY_MS)
  for (const id of ['wt-old', 'wt-old-parent', 'wt-ran-since']) await stopped(PROJ, id)
  await stopped(OTHER, 'wt-other-old')
  await queueWorkspace(local, PROJ, { parent: 'wt-old-parent', prompt: 'next', tool: 'claude' }, 'user')
  vi.setSystemTime(Date.now() + 1)
  await recordWorkspaceLife(PROJ, 'wt-ran-since')
  vi.setSystemTime(now - 2 * DAY_MS)
  await stopped(PROJ, 'wt-recent')
  await recordWorkspaceStopped(PROJ, 'wt-ran-since')
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-running' })
  vi.setSystemTime(now)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function stopped(projectId: string, id: string): Promise<void> {
  await recordWorkspaceCreated({ projectId, workspaceId: id })
  await recordWorkspaceStopped(projectId, id)
  await fs.mkdir(workspaceDir(projectId, id), { recursive: true })
}

async function kept(projectId: string, ids: string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) if (await getWorkspaceRow(projectId, id)) out.push(id)
  return out
}

describe('previewWorkspaceRetention', () => {
  it('counts the project\'s workspaces stopped longer than the retention, and the cutoff it counted by', async () => {
    expect(await previewWorkspaceRetention(PROJ, 5)).toEqual({ expired: 2, before: new Date(Date.now() - 5 * DAY_MS) })
    expect((await previewWorkspaceRetention(PROJ, 1)).expired).toBe(4)
    expect((await previewWorkspaceRetention(PROJ, 30)).expired).toBe(0)
    expect(await kept(PROJ, ALL)).toEqual(ALL)
  })
})

describe('setWorkspaceRetention', () => {
  it('stores the owner\'s retention, deletes this project\'s backlog up to the confirmed cutoff, and reports what it kept', async () => {
    await expect(setWorkspaceRetention(teammate, PROJ, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await getProjectRow(PROJ))?.stoppedWorkspaceRetentionDays).toBeUndefined()

    // Confirmed against a 5-day count, then saved at 1 day: nothing stopped
    // after that count's cutoff goes yet. The queued entry's parent is
    // refused, so one of the two goes.
    const { before } = await previewWorkspaceRetention(PROJ, 5)
    expect(await setWorkspaceRetention(local, PROJ, 1, before)).toEqual({
      deleted: 1,
      kept: [{ workspaceId: 'wt-old-parent', reason: expect.stringContaining('queued workspace(s) waiting on it') as string }],
    })
    expect((await getProjectRow(PROJ))?.stoppedWorkspaceRetentionDays).toBe(1)
    expect(await kept(PROJ, ALL)).toEqual(['wt-old-parent', 'wt-ran-since', 'wt-recent', 'wt-running'])
    await expect(fs.access(workspaceDir(PROJ, 'wt-old'))).rejects.toThrow()
    expect(await kept(OTHER, ['wt-other-old'])).toEqual(['wt-other-old'])

    // Without a cutoff, the retention's own.
    expect((await setWorkspaceRetention(local, PROJ, 1)).deleted).toBe(2)
    expect(await kept(PROJ, ALL)).toEqual(['wt-old-parent', 'wt-running'])

    expect(await setWorkspaceRetention(local, PROJ, null)).toEqual({ deleted: 0, kept: [] })
    expect((await getProjectRow(PROJ))?.stoppedWorkspaceRetentionDays).toBeUndefined()
  })
})

describe('reconcileWorkspaceRetention', () => {
  it('deletes workspaces as they age past their own project\'s retention', async () => {
    // Off by default.
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, ALL)).toEqual(ALL)

    // A shutdown stops the pass before it deletes anything.
    await setProjectWorkspaceRetention(PROJ, 5)
    await reconcileWorkspaceRetention(AbortSignal.abort())
    expect(await kept(PROJ, ALL)).toEqual(ALL)

    // wt-ran-since is aged from its last stop, not the one its lost clear
    // left behind. OTHER has no retention of its own.
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, ALL)).toEqual(['wt-old-parent', 'wt-ran-since', 'wt-recent', 'wt-running'])
    expect(await kept(OTHER, ['wt-other-old'])).toEqual(['wt-other-old'])

    vi.setSystemTime(Date.now() + 4 * DAY_MS)
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, ALL)).toEqual(['wt-old-parent', 'wt-running'])
  })
})
