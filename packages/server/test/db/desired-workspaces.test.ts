import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { desiredWorkspaces } from '#db/desired-workspaces'
import {
  recordWorkspaceCreated,
  recordWorkspaceLaunched,
  recordWorkspaceLife,
  recordWorkspaceStopped,
} from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { insertSession, markSessionsLaunched } from '#db/session-store'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

describe('desiredWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('answers the live workspaces, not the stopped ones', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'live-1' })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'gone-1' })
    await recordWorkspaceStopped(PROJ, 'gone-1')

    const desired = await desiredWorkspaces()
    expect(desired.live.map((w) => w.workspaceId)).toEqual(['live-1'])
  })

  // `ran` is what separates an interrupted create from a workspace with real
  // history whose runtime went away — the difference between the reaper
  // recording `never-started` and `orphaned`.
  // A conversation proves its agent started, since only a live agent names
  // one; a launched session proves the create got that far. A session
  // recorded but never launched proves nothing.
  it('marks a workspace whose agent got going as having run', async () => {
    for (const id of ['wt-1', 'wt-2', 'wt-3']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id })
    await recordConversations(PROJ, 'wt-1', [{ tool: 'claude', conversationId: 'conv-a' }])
    const claude = { tool: 'claude', mode: 'tui', permissionMode: 'bypass', cwd: '' } as const
    await markSessionsLaunched([(await insertSession(PROJ, 'wt-2', claude)).id])
    await insertSession(PROJ, 'wt-3', claude)

    expect((await desiredWorkspaces()).live.map((w) => [w.workspaceId, w.ran]))
      .toEqual([['wt-1', true], ['wt-2', true], ['wt-3', false]])
  })

  // A restart's life that has not come up is one a create of this process
  // is starting, or one the server died under. A first life, and a restart
  // that came up, are neither.
  it('names the life before, for a workspace whose restart has not come up', async () => {
    const first = new Date(Date.now() - 60_000)
    for (const id of ['fresh', 'restarting', 'restarted']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id, at: first })
    for (const id of ['restarting', 'restarted']) {
      await recordWorkspaceLaunched(PROJ, id)
      await recordWorkspaceStopped(PROJ, id)
      await recordWorkspaceLife(PROJ, id, { at: new Date() })
    }
    await recordWorkspaceLaunched(PROJ, 'restarted')

    expect((await desiredWorkspaces()).live.map((w) => [w.workspaceId, w.restartedFrom]).sort())
      .toEqual([['fresh', undefined], ['restarted', undefined], ['restarting', first]])
  })

  // A whole set every time, straight off the rows — a workspace recorded as
  // stopped since the last read leaves the live set on the very next one.
  it('answers fresh on every read', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-1' })
    expect((await desiredWorkspaces()).live).toHaveLength(1)
    await recordWorkspaceStopped(PROJ, 'wt-1')

    expect((await desiredWorkspaces()).live).toEqual([])
  })
})
