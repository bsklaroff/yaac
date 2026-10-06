import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { desiredWorkspaces } from '#db/desired-workspaces'
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
} from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'

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

  it('answers the live workspaces and the ids already recorded as stopped', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'live-1' })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'gone-1' })
    await recordWorkspaceStopped(PROJ, 'gone-1')

    const desired = await desiredWorkspaces()
    expect(desired.live.map((w) => w.workspaceId)).toEqual(['live-1'])
    expect(desired.stopped).toEqual([`${PROJ}/gone-1`])
  })

  // `ran` is what separates an interrupted create from a workspace with real
  // history whose runtime went away — the difference between the reaper
  // recording `never-started` and `orphaned`.
  it('marks a workspace whose agent got going as having run', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-1' })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-2' })
    // A link alone proves nothing — create writes one before the agent
    // launches. A captured opening message is the evidence.
    await recordAgentSessions(PROJ, 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'do the thing' },
    ])
    await recordAgentSessions(PROJ, 'wt-2', [
      { tool: 'claude', agentSessionId: 'conv-b' },
    ])

    expect((await desiredWorkspaces()).live.map((w) => [w.workspaceId, w.ran]))
      .toEqual([['wt-1', true], ['wt-2', false]])
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
