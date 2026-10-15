import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { recordedLaunch } from '#domain/workspaces'
import { clearPrewarmStateForTests, spareSettings } from '#domain/workspaces/prewarm'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearPrewarmStateForTests()
})

afterEach(async () => {
  clearPrewarmStateForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('recordedLaunch', () => {
  // An `acp` spare's watcher handshakes while it warms, when it has no row
  // yet. Once a claim inserts one, the claimed settings win, and a rollback
  // that deletes it brings the warm-time ones back.
  it('answers from the row, else from the spare\'s warm-time settings, else nothing', async () => {
    spareSettings.set('s1', { mode: 'acp', permissionMode: 'plan', model: 'claude-opus-5-5', effort: 'high' })
    expect(await recordedLaunch(PROJ, 's1')).toMatchObject({
      permissionMode: 'plan', model: 'claude-opus-5-5', effort: 'high',
    })

    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 's1', permissionMode: 'accept-edits', mode: 'acp' })
    const claimed = await recordedLaunch(PROJ, 's1')
    expect(claimed?.permissionMode).toBe('accept-edits')
    expect(claimed?.model).toBeUndefined()

    expect(await recordedLaunch(PROJ, 'gone')).toBeUndefined()
  })
})
