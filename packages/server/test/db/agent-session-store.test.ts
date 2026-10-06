import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { getDb } from '#db/client'
import { agentSessions } from '#db/schema'
import {
  recordedConversationHandles,
  deleteWorkspaceAgentSessions,
  listWorkspaceAgentSessions,
  recordAgentSessions,
} from '#db/agent-session-store'
import { recordWorkspaceCreated } from '#db/workspace-store'

/**
 * The store's writes are covered through the reconciler and the listings that
 * consume them; what needs its own test is the one delete that has to reason
 * about the many-to-many, because a wrong answer there is unrecoverable rather
 * than re-reconciled on the next tick.
 */
describe('deleteWorkspaceAgentSessions', () => {
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
  const conversations = async (): Promise<string[]> => {
    const db = await getDb()
    return (await db.select({ id: agentSessions.agentSessionId }).from(agentSessions))
      .map((r) => r.id).sort()
  }

  it('takes the conversations a rolled-back create invented, but not shared ones', async () => {
    // wt-doomed is the create that gave up: it wrote its own conversation and
    // also linked one it was told to resume, which wt-live still holds. Only
    // the first is the rollback's to erase — a conversation another workspace
    // links is that workspace's history, and nothing would bring it back.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-live' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-doomed' })
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-live', [
      { tool: 'claude', agentSessionId: 'conv-shared' },
    ])
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-doomed', [
      { tool: 'claude', agentSessionId: 'conv-shared' },
      { tool: 'claude', agentSessionId: 'conv-own', firstPrompt: 'the ask nobody heard' },
    ])

    await deleteWorkspaceAgentSessions(DEMO_PROJECT_ID, 'wt-doomed')

    expect(await listWorkspaceAgentSessions(DEMO_PROJECT_ID, 'wt-doomed')).toEqual([])
    expect(await conversations()).toEqual(['conv-shared'])
    // The surviving workspace keeps its link to the shared one.
    expect((await listWorkspaceAgentSessions(DEMO_PROJECT_ID, 'wt-live')).map((l) => l.agentSessionId))
      .toEqual(['conv-shared'])
  })

  it('is a no-op for a workspace that linked nothing', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-bare' })
    await expect(deleteWorkspaceAgentSessions(DEMO_PROJECT_ID, 'wt-bare')).resolves.toBeUndefined()
    expect(await conversations()).toEqual([])
  })
})

/**
 * Covered here for one decision only: which captured values a re-sighting is
 * allowed to REPLACE. Every other write this makes is exercised through the
 * reconciler and the listings that read it back.
 */
describe('recordAgentSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const conversation = async (id: string) =>
    (await listWorkspaceAgentSessions(DEMO_PROJECT_ID, 'wt-1')).find((l) => l.agentSessionId === id)

  it('follows a model switch but keeps the opening message', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'ship it', model: 'claude-opus-5' },
    ])
    // The same conversation, seen again after a `/model` — and after a
    // compaction that left a different message at the head of its transcript.
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-1', [
      {
        tool: 'claude',
        agentSessionId: 'conv-a',
        firstPrompt: 'continue where we left off',
        model: 'claude-fable-5',
      },
    ])

    const row = await conversation('conv-a')
    // The model is a fact about now, so the later sighting wins; the opening
    // message is a fact about the conversation's birth, so the first does.
    expect(row?.model).toBe('claude-fable-5')
    expect(row?.firstPrompt).toBe('ship it')
  })

  it('leaves a recorded model alone when a sighting read none', async () => {
    // Absent means "not read" — a sweep that could not resolve the transcript
    // this tick, or a tool that never reports one. Treating it as "no model"
    // would blank the label on every such tick.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-b', model: 'claude-opus-5' },
    ])
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-b', paneId: '%1' },
    ])

    expect((await conversation('conv-b'))?.model).toBe('claude-opus-5')
  })
})

describe('recordedConversationHandles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // Keyed by the driver's handle, and only conversations that are on one:
  // the ACP driver re-addresses a live agent by handle, so a link with no
  // pane id names nothing it could attach to.
  it('reports only the recorded conversations that sit on a handle', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordAgentSessions(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', paneId: '%0' },
      { tool: 'claude', agentSessionId: 'conv-b' },
      { tool: 'claude', agentSessionId: 'conv-c', paneId: '%2' },
    ])

    expect(await recordedConversationHandles(DEMO_PROJECT_ID, 'wt-1')).toEqual([
      { handle: '%0', agentSessionId: 'conv-a' },
      { handle: '%2', agentSessionId: 'conv-c' },
    ])
  })
})
