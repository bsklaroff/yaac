import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { markWaitingSeen } from '#domain/workspaces'
import { BUILT_IN_USER_ID, getWorkspaceRow } from '#db'
import { recordProject } from '#db/project-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import {
  readWorkspaceWaitingSince,
  setAgentStatus,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetWorkspaceStatusStoreForTests()
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'w1' })
})

afterEach(async () => {
  vi.useRealTimers()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('markWaitingSeen', () => {
  const seen = async (): Promise<boolean | undefined> => (await getWorkspaceRow(PROJ, 'w1'))?.waitingSeen

  // A request can arrive after the spell it names has ended, or after a
  // server restart restamped it; only the current spell is recorded.
  it('records only the workspace\'s current waiting spell', async () => {
    vi.useFakeTimers({ now: 1_000 })
    setAgentStatus(PROJ, 'w1', '%0', 'waiting')
    const spell = readWorkspaceWaitingSince(PROJ, 'w1') ?? 0

    expect(await markWaitingSeen(local, PROJ, 'w1', spell - 1)).toBe(false)
    expect(await seen()).toBe(false)
    expect(await markWaitingSeen(local, PROJ, 'w1', spell)).toBe(true)
    expect(await markWaitingSeen(local, PROJ, 'w1', spell)).toBe(true)
    expect(await seen()).toBe(true)

    // Working, then a new spell: the old stamp no longer names it.
    setAgentStatus(PROJ, 'w1', '%0', 'running')
    expect(await markWaitingSeen(local, PROJ, 'w1', spell)).toBe(false)
    vi.setSystemTime(2_000)
    setAgentStatus(PROJ, 'w1', '%0', 'waiting')
    expect(await markWaitingSeen(local, PROJ, 'w1', spell)).toBe(false)
  })

  it('refuses a workspace the project has no row for', async () => {
    await expect(markWaitingSeen(local, PROJ, 'ghost', 0)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
