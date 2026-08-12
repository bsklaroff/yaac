import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { getDb } from '#db/client'
import { agentSessions } from '#db/schema'
import {
  recordedConversationHandles,
  deleteWorktreeAgentSessions,
  listWorktreeAgentSessions,
  recordAgentSessions,
} from '#db/agent-session-store'
import { recordWorktreeCreated } from '#db/worktree-store'

/**
 * The store's writes are covered through the reconciler and the listings that
 * consume them; what needs its own test is the one delete that has to reason
 * about the many-to-many, because a wrong answer there is unrecoverable rather
 * than re-reconciled on the next tick.
 */
describe('deleteWorktreeAgentSessions', () => {
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
    // the first is the rollback's to erase — a conversation another worktree
    // links is that worktree's history, and nothing would bring it back.
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-live' })
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-doomed' })
    await recordAgentSessions('demo', 'wt-live', [
      { tool: 'claude', agentSessionId: 'conv-shared' },
    ])
    await recordAgentSessions('demo', 'wt-doomed', [
      { tool: 'claude', agentSessionId: 'conv-shared' },
      { tool: 'claude', agentSessionId: 'conv-own', firstPrompt: 'the ask nobody heard' },
    ])

    await deleteWorktreeAgentSessions('demo', 'wt-doomed')

    expect(await listWorktreeAgentSessions('demo', 'wt-doomed')).toEqual([])
    expect(await conversations()).toEqual(['conv-shared'])
    // The surviving worktree keeps its link to the shared one.
    expect((await listWorktreeAgentSessions('demo', 'wt-live')).map((l) => l.agentSessionId))
      .toEqual(['conv-shared'])
  })

  it('is a no-op for a worktree that linked nothing', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-bare' })
    await expect(deleteWorktreeAgentSessions('demo', 'wt-bare')).resolves.toBeUndefined()
    expect(await conversations()).toEqual([])
  })
})

describe('recordedConversationHandles', () => {
  // Keyed by the driver's handle, and only conversations that are on one:
  // the ACP driver re-addresses a live agent by handle, so a link with no
  // pane id names nothing it could attach to.
  it('reports only the recorded conversations that sit on a handle', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-1' })
    await recordAgentSessions('demo', 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', paneId: '%0' },
      { tool: 'claude', agentSessionId: 'conv-b' },
      { tool: 'claude', agentSessionId: 'conv-c', paneId: '%2' },
    ])

    expect(await recordedConversationHandles('demo', 'wt-1')).toEqual([
      { handle: '%0', agentSessionId: 'conv-a' },
      { handle: '%2', agentSessionId: 'conv-c' },
    ])
  })
})
