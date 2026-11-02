import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { getDb } from '#db/client'
import { conversations } from '#db/schema'
import {
  deleteWorkspaceConversations,
  listUncapturedStoppedConversations,
  listWorkspaceConversations,
  conversationTitle,
  openingPrompt,
  recordConversations,
} from '#db/conversation-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'

/**
 * The store's writes are covered through the reconciler and the listings that
 * consume them; what needs its own test is the one delete that has to reason
 * about the many-to-many, because a wrong answer there is unrecoverable rather
 * than re-reconciled on the next tick.
 */
describe('deleteWorkspaceConversations', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The conversation rows themselves — read straight from the table, because
   *  the whole point of an orphan is that no listing would show it. */
  const conversationIds = async (): Promise<string[]> => {
    const db = await getDb()
    return (await db.select({ id: conversations.conversationId }).from(conversations))
      .map((r) => r.id).sort()
  }

  it('takes the conversations a rolled-back create invented, but not shared ones', async () => {
    // wt-doomed is the create that gave up: it wrote its own conversation and
    // also linked one it was told to resume, which wt-live still holds. Only
    // the first is the rollback's to erase — a conversation another workspace
    // links is that workspace's history, and nothing would bring it back.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-live' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-doomed' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-live', [
      { tool: 'claude', conversationId: 'conv-shared' },
    ])
    await recordConversations(DEMO_PROJECT_ID, 'wt-doomed', [
      { tool: 'claude', conversationId: 'conv-shared' },
      { tool: 'claude', conversationId: 'conv-own', firstPrompt: 'the ask nobody heard' },
    ])

    await deleteWorkspaceConversations(DEMO_PROJECT_ID, 'wt-doomed')

    expect(await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-doomed')).toEqual([])
    expect(await conversationIds()).toEqual(['conv-shared'])
    // The surviving workspace keeps its link to the shared one.
    expect((await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-live')).map((l) => l.conversationId))
      .toEqual(['conv-shared'])
  })

  it('is a no-op for a workspace that linked nothing', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-bare' })
    await expect(deleteWorkspaceConversations(DEMO_PROJECT_ID, 'wt-bare')).resolves.toBeUndefined()
    expect(await conversationIds()).toEqual([])
  })
})

/**
 * Covered here for one decision only: which captured values a re-sighting is
 * allowed to REPLACE. Every other write this makes is exercised through the
 * reconciler and the listings that read it back.
 */
describe('recordConversations', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const conversation = async (id: string) =>
    (await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1')).find((l) => l.conversationId === id)

  it('follows a model switch and a retitle but keeps the opening message', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-a', firstPrompt: 'ship it', model: 'claude-opus-5', title: 'Ship it' },
    ])
    // The same conversation, seen again after a `/model` — and after a
    // compaction that left a different message at the head of its transcript.
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      {
        tool: 'claude',
        conversationId: 'conv-a',
        firstPrompt: 'continue where we left off',
        model: 'claude-fable-5',
        title: 'Release checklist',
      },
    ])

    const row = await conversation('conv-a')
    // The model and title are facts about now, so the later sighting wins;
    // the opening message is a fact about the conversation's birth, so the
    // first does.
    expect(row?.model).toBe('claude-fable-5')
    expect(row?.title).toBe('Release checklist')
    expect(row?.firstPrompt).toBe('ship it')
  })

  it('leaves a recorded model and title alone when a sighting read none', async () => {
    // Absent means "not read" — a sweep that could not resolve the transcript
    // this tick, or a tool that never reports one. Treating it as "no model"
    // would blank the label on every such tick.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-b', model: 'claude-opus-5', title: 'Lexer port' },
    ])
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-b' },
    ])

    expect(await conversation('conv-b')).toMatchObject({ model: 'claude-opus-5', title: 'Lexer port' })
  })

  it('links a conversation to the session holding it, which a sighting naming none keeps', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    const sessionId = '11111111-2222-4333-8444-555555555555'
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [{ tool: 'claude', conversationId: 'conv-c', sessionId }])
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [{ tool: 'claude', conversationId: 'conv-c' }])

    expect(await conversation('conv-c')).toMatchObject({ sessionId })
  })
})

describe('openingPrompt', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // A first conversation that captured nothing (a chat tab left blank, or a
  // claimed spare's warm-time conversation) must not hide a later one's.
  it('is the earliest message any conversation opened with', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-blank' },
      { tool: 'claude', conversationId: 'conv-a', firstPrompt: 'port the lexer' },
      { tool: 'claude', conversationId: 'conv-b', firstPrompt: 'a side question' },
    ])

    expect(openingPrompt(await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1'))).toBe('port the lexer')
    expect(openingPrompt([])).toBeUndefined()
  })
})

describe('conversationTitle', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // The conversation whose message labels the workspace names it too, even
  // when an earlier, unprompted one has a title of its own.
  it("is the opening conversation's title, else the first one any conversation has", async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-blank', title: 'Blank tab' },
      { tool: 'claude', conversationId: 'conv-a', firstPrompt: 'port the lexer', title: 'Lexer port' },
      { tool: 'claude', conversationId: 'conv-b', firstPrompt: 'a side question', title: 'Side question' },
    ])
    expect(conversationTitle(await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1'))).toBe('Lexer port')

    // An opening conversation its agent has not titled yet falls back to
    // another's title; none at all is undefined.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-2' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-2', [
      { tool: 'claude', conversationId: 'conv-c', firstPrompt: 'port the parser' },
      { tool: 'claude', conversationId: 'conv-d', title: 'Parser notes' },
    ])
    const links = await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-2')
    expect(conversationTitle(links)).toBe('Parser notes')
    expect(conversationTitle(links.slice(0, 1))).toBeUndefined()
  })
})

describe('listUncapturedStoppedConversations', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

  it('lists stopped workspaces\' conversations with no recorded activity, newest stop first, up to the limit', async () => {
    for (const id of ['wt-old', 'wt-new', 'wt-done', 'wt-live']) {
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: id })
    }
    await recordConversations(DEMO_PROJECT_ID, 'wt-old', [{ tool: 'claude', conversationId: 'conv-old' }])
    await recordConversations(DEMO_PROJECT_ID, 'wt-new', [
      { tool: 'claude', conversationId: 'conv-new' },
      { tool: 'claude', conversationId: 'conv-cleared' },
    ])
    await recordConversations(DEMO_PROJECT_ID, 'wt-done', [
      { tool: 'claude', conversationId: 'conv-done', lastActiveMs: Date.parse('2026-01-02') },
    ])
    await recordConversations(DEMO_PROJECT_ID, 'wt-live', [{ tool: 'claude', conversationId: 'conv-live' }])
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'wt-old')
    await tick()
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'wt-done')
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'wt-new')

    expect((await listUncapturedStoppedConversations(10)).map((l) => [l.workspaceId, l.conversationId]))
      .toEqual([['wt-new', 'conv-new'], ['wt-new', 'conv-cleared'], ['wt-old', 'conv-old']])
    expect(await listUncapturedStoppedConversations(1)).toHaveLength(1)
  })
})
