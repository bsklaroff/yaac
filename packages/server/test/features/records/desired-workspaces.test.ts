import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#platform/db/client'
import { pushDesiredWorkspaces } from '#features/records/desired-workspaces'
import { desiredWorkspaces, _resetDesiredWorkspacesForTests } from '#herd-desired'
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
} from '#features/records/worktree-store'
import { recordAgentSessions } from '#features/records/agent-session-store'

describe('pushDesiredWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    _resetDesiredWorkspacesForTests()
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('publishes the live worktrees and the ids already recorded as stopped', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'live-1' })
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'gone-1' })
    await recordWorktreeStopped('proj', 'gone-1')

    await pushDesiredWorkspaces([])

    const desired = desiredWorkspaces()
    expect(desired?.live.map((w) => w.worktreeId)).toEqual(['live-1'])
    expect(desired?.stopped).toEqual(['proj/gone-1'])
  })

  // `ran` is what separates an interrupted create from a workspace with real
  // history whose runtime went away — the difference between the reaper
  // recording `never-started` and `orphaned`.
  it('marks a worktree whose agent got going as having run', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-1' })
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-2' })
    // A link alone proves nothing — create writes one before the agent
    // launches. A captured opening message is the evidence.
    await recordAgentSessions('proj', 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'do the thing' },
    ])
    await recordAgentSessions('proj', 'wt-2', [
      { tool: 'claude', agentSessionId: 'conv-b' },
    ])

    await pushDesiredWorkspaces([])

    expect(desiredWorkspaces()?.live.map((w) => [w.worktreeId, w.ran]))
      .toEqual([['wt-1', true], ['wt-2', false]])
  })

  // Replaces rather than merges: a whole set every time is what lets a herd
  // that reconnects learn the truth in one push.
  it('replaces the previous set', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-1' })
    await pushDesiredWorkspaces([])
    await recordWorktreeStopped('proj', 'wt-1')

    await pushDesiredWorkspaces([])

    expect(desiredWorkspaces()?.live).toEqual([])
  })
})
