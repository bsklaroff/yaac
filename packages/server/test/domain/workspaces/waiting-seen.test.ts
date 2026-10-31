import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { markWaitingSeen } from '#domain/workspaces'
import { BUILT_IN_USER_ID, getSessionRow, insertSession, type SessionRow } from '#db'
import { recordProject } from '#db/project-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import {
  readAgentStatus,
  setAgentStatus,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const teammate = { kind: 'tailnet', userId: '5b1c9d3e-2f0a-4e6b-9c7d-8a1e2f3b4c5d', login: 'tm@x', name: 'Tm' } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
let session: SessionRow
let other: SessionRow

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetWorkspaceStatusStoreForTests()
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'w1' })
  session = await insertSession(PROJ, 'w1', { tool: 'claude', mode: 'acp', permissionMode: 'bypass' })
  other = await insertSession(PROJ, 'w1', { tool: 'codex', mode: 'tui', permissionMode: 'bypass' })
})

afterEach(async () => {
  vi.useRealTimers()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('markWaitingSeen', () => {
  const seen = async (row: SessionRow): Promise<string[] | undefined> => (await getSessionRow(row.id))?.waitingSeenBy

  // A request can arrive after the spell it names has ended, or after a
  // server restart restamped it; only the session's current spell is
  // recorded. Each user who views it is recorded, the owner and a teammate
  // alike, and a sibling session's spell is its own.
  it("records each viewer of only the session's current waiting spell", async () => {
    vi.useFakeTimers({ now: 1_000 })
    setAgentStatus(PROJ, 'w1', session.window, 'waiting')
    setAgentStatus(PROJ, 'w1', other.window, 'waiting')
    const spell = readAgentStatus(PROJ, 'w1', session.window)?.waitingSinceMs ?? 0

    expect(await markWaitingSeen(local, session.id, spell - 1)).toBe(false)
    expect(await seen(session)).toEqual([])
    expect(await markWaitingSeen(teammate, session.id, spell)).toBe(true)
    expect(await seen(session)).toEqual([teammate.userId])
    expect(await markWaitingSeen(local, session.id, spell)).toBe(true)
    expect(await markWaitingSeen(local, session.id, spell)).toBe(true)
    expect(await seen(session)).toEqual([teammate.userId, BUILT_IN_USER_ID])
    expect(await seen(other)).toEqual([])

    // Working, then a new spell: the old stamp no longer names it.
    setAgentStatus(PROJ, 'w1', session.window, 'running')
    expect(await markWaitingSeen(local, session.id, spell)).toBe(false)
    vi.setSystemTime(2_000)
    setAgentStatus(PROJ, 'w1', session.window, 'waiting')
    expect(await markWaitingSeen(local, session.id, spell)).toBe(false)
  })

  it('marks nothing for a session whose agent has no status yet', async () => {
    expect(await markWaitingSeen(local, session.id, 0)).toBe(false)
  })

  it('refuses a session there is no row for', async () => {
    await expect(markWaitingSeen(local, '0a0a0a0a-0000-4000-8000-0000000000ff', 0)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
