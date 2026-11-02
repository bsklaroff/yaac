import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, removeWorkspaceRecords } from '#db/workspace-store'
import { listWorkspaceConversations, recordConversations } from '#db/conversation-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import {
  closeSessionRow,
  getSessionRow,
  holdSessionPrompt,
  insertSession,
  listOpenSessionsFor,
  listWorkspaceSessions,
  markSessionsLaunched,
  recordSessionWaitingSeen,
  sessionWindowName,
  setSessionTitle,
  takeSessionPrompt,
} from '#db/session-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const TEAMMATE = '5b1c9d3e-2f0a-4e6b-9c7d-8a1e2f3b4c5d'
const claude = { tool: 'claude', mode: 'tui', permissionMode: 'bypass' } as const

let tmpDir: string
let pushes: number

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetWorkspaceListChangedForTests()
  pushes = 0
  onWorkspaceListChanged(() => { pushes += 1 })
  for (const workspaceId of ['w1', 'w2']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId })
})

afterEach(async () => {
  _resetWorkspaceListChangedForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('sessionWindowName', () => {
  // Readable in a `tmux attach`, and unique in its workspace.
  it('names the window for its tool and the head of its id', () => {
    expect(sessionWindowName('codex', '1a2b3c4d-0000-4000-8000-000000000000')).toBe('codex-1a2b3c4d')
  })
})

describe('insertSession', () => {
  it('opens sessions after a workspace\'s others, each in a window of its own, with its settings', async () => {
    const a = await insertSession(PROJ, 'w1', { ...claude, model: 'claude-opus-5-5', effort: 'high', title: '  lead  ' })
    const b = await insertSession(PROJ, 'w1', { tool: 'codex', mode: 'acp', permissionMode: 'read-only' })
    const other = await insertSession(PROJ, 'w2', claude)

    expect([a.ordinal, b.ordinal, other.ordinal]).toEqual([0, 1, 0])
    expect(a).toMatchObject({
      projectId: PROJ, workspaceId: 'w1', tool: 'claude', mode: 'tui', permissionMode: 'bypass',
      model: 'claude-opus-5-5', effort: 'high', title: 'lead', window: sessionWindowName('claude', a.id),
      waitingSeenBy: [],
    })
    expect(a.closedAt).toBeUndefined()
    expect(a.launchedAt).toBeUndefined()
    expect(pushes).toBe(3)
  })

  // A chat's opening message waits on the row for its conversation; a
  // terminal's is typed in by whoever launches it.
  it('holds an acp session\'s opening message for its conversation, and keeps every session\'s first', async () => {
    const chat = await insertSession(PROJ, 'w1', { ...claude, mode: 'acp', prompt: 'fix the lexer' })
    const term = await insertSession(PROJ, 'w1', { ...claude, prompt: 'port the parser' })
    expect(chat).toMatchObject({ firstPrompt: 'fix the lexer', pendingPrompt: 'fix the lexer' })
    expect(term.firstPrompt).toBe('port the parser')
    expect(term.pendingPrompt).toBeUndefined()
  })

  // A conversation an agent ran in a terminal comes back as a session of its
  // own, which then holds it, so a later restart does not adopt it again.
  it('takes over the link of a conversation it is opened on', async () => {
    await recordConversations(PROJ, 'w1', [{ tool: 'claude', conversationId: 'conv-a' }])
    const s = await insertSession(PROJ, 'w1', { ...claude, conversationId: 'conv-a' })
    expect(s.conversationId).toBe('conv-a')
    expect((await listWorkspaceConversations(PROJ, 'w1'))[0]?.sessionId).toBe(s.id)
  })
})

describe('listWorkspaceSessions', () => {
  it('lists a workspace\'s open sessions in order, or with `all` its closed ones too', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    const b = await insertSession(PROJ, 'w1', claude)
    await closeSessionRow(a.id)
    expect((await listWorkspaceSessions('w1')).map((s) => s.id)).toEqual([b.id])
    expect((await listWorkspaceSessions('w1', { all: true })).map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('goes with its workspace', async () => {
    await insertSession(PROJ, 'w1', claude)
    await removeWorkspaceRecords(PROJ, 'w1')
    expect(await listWorkspaceSessions('w1', { all: true })).toEqual([])
  })
})

describe('listOpenSessionsFor', () => {
  it('reads several workspaces\' open sessions in one query, by workspace', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    const closed = await insertSession(PROJ, 'w2', claude)
    await closeSessionRow(closed.id)
    const b = await insertSession(PROJ, 'w2', claude)
    const byWorkspace = await listOpenSessionsFor(['w1', 'w2', 'none'])
    expect([...byWorkspace].map(([w, rows]) => [w, rows.map((r) => r.id)])).toEqual([['w1', [a.id]], ['w2', [b.id]]])
    expect(await listOpenSessionsFor([])).toEqual(new Map())
  })
})

describe('getSessionRow', () => {
  it('reads one session, or nothing for an unknown id', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    expect((await getSessionRow(a.id))?.id).toBe(a.id)
    expect(await getSessionRow('0a0a0a0a-0000-4000-8000-0000000000ff')).toBeUndefined()
  })
})

describe('closeSessionRow', () => {
  it('closes an open session once, dropping a held prompt', async () => {
    const a = await insertSession(PROJ, 'w1', { ...claude, mode: 'acp', prompt: 'go' })
    expect(await closeSessionRow(a.id)).toBe(true)
    expect(await closeSessionRow(a.id)).toBe(false)
    const row = await getSessionRow(a.id)
    expect(row?.closedAt).toBeInstanceOf(Date)
    expect(row?.pendingPrompt).toBeUndefined()
  })

  // A closed window's name is free again for a new session.
  it('frees its window name', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    await closeSessionRow(a.id)
    await expect(insertSession(PROJ, 'w1', claude)).resolves.toBeDefined()
  })
})

describe('setSessionTitle', () => {
  it('normalizes a title and clears it on a blank one', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    await setSessionTitle(a.id, '  fix   the parser ')
    expect((await getSessionRow(a.id))?.title).toBe('fix the parser')
    await setSessionTitle(a.id, '   ')
    expect((await getSessionRow(a.id))?.title).toBeUndefined()
  })
})

describe('markSessionsLaunched', () => {
  it('stamps when each named session was launched, and nothing for none', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    const b = await insertSession(PROJ, 'w1', claude)
    await markSessionsLaunched([a.id])
    await markSessionsLaunched([])
    expect((await getSessionRow(a.id))?.launchedAt).toBeInstanceOf(Date)
    expect((await getSessionRow(b.id))?.launchedAt).toBeUndefined()
  })
})

describe('takeSessionPrompt', () => {
  // Taken by compare-and-set, so of two callers racing to deliver it only
  // one gets it.
  it('hands the held prompt to one caller only', async () => {
    const a = await insertSession(PROJ, 'w1', { ...claude, mode: 'acp', prompt: 'ship it' })
    const [first, second] = await Promise.all([takeSessionPrompt(a.id), takeSessionPrompt(a.id)])
    expect([first, second].filter((p) => p === 'ship it')).toHaveLength(1)
    expect(await takeSessionPrompt(a.id)).toBeUndefined()
  })
})

describe('holdSessionPrompt', () => {
  it('holds a prompt again, never over one already held nor for a closed session', async () => {
    const a = await insertSession(PROJ, 'w1', { ...claude, mode: 'acp', prompt: 'first' })
    await holdSessionPrompt(a.id, 'second')
    expect(await takeSessionPrompt(a.id)).toBe('first')
    await holdSessionPrompt(a.id, 'again')
    expect(await takeSessionPrompt(a.id)).toBe('again')
    await closeSessionRow(a.id)
    await holdSessionPrompt(a.id, 'late')
    expect(await takeSessionPrompt(a.id)).toBeUndefined()
  })
})

describe('recordSessionWaitingSeen', () => {
  it('marks a session read by each user once, notifying only for a new one', async () => {
    const a = await insertSession(PROJ, 'w1', claude)
    const before = pushes
    await recordSessionWaitingSeen(a.id, BUILT_IN_USER_ID)
    await recordSessionWaitingSeen(a.id, TEAMMATE)
    await recordSessionWaitingSeen(a.id, BUILT_IN_USER_ID)
    expect((await getSessionRow(a.id))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID, TEAMMATE])
    expect(pushes - before).toBe(2)
  })
})
