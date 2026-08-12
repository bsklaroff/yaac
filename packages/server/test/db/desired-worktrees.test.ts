import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { desiredWorktrees } from '#db/desired-worktrees'
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
} from '#db/worktree-store'
import { recordAgentSessions } from '#db/agent-session-store'

describe('desiredWorktrees', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('answers the live worktrees and the ids already recorded as stopped', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'live-1' })
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'gone-1' })
    await recordWorktreeStopped('proj', 'gone-1')

    const desired = await desiredWorktrees()
    expect(desired.live.map((w) => w.worktreeId)).toEqual(['live-1'])
    expect(desired.stopped).toEqual(['proj/gone-1'])
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

    expect((await desiredWorktrees()).live.map((w) => [w.worktreeId, w.ran]))
      .toEqual([['wt-1', true], ['wt-2', false]])
  })

  // A whole set every time, straight off the rows — a worktree recorded as
  // stopped since the last read leaves the live set on the very next one.
  it('answers fresh on every read', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-1' })
    expect((await desiredWorktrees()).live).toHaveLength(1)
    await recordWorktreeStopped('proj', 'wt-1')

    expect((await desiredWorktrees()).live).toEqual([])
  })
})
