import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { applyWorkspaceEvent, BUILT_IN_USER_ID, getProjectRow, getWorkspaceRow } from '#db'
import { closeDb } from '#db/client'
import { keepScratchDirsInCheckout } from '#domain/workspaces'

const OWNER = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const STRANGER = { kind: 'local', userId: '0a0a0a0a-0000-4000-8000-0000000000aa' } as const

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(DEMO_PROJECT_ID)
  await applyWorkspaceEvent({
    type: 'workspace-created', projectId: DEMO_PROJECT_ID, workspaceId: 'wt', scratchDirs: ['node_modules', 'target'],
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('keepScratchDirsInCheckout', () => {
  it('takes the paths off the project\'s scratch dirs and the ones the workspace started with', async () => {
    await keepScratchDirsInCheckout(OWNER, 'wt', ['target'])

    expect((await getProjectRow(DEMO_PROJECT_ID))?.scratchDirs.dirs).toEqual([{ path: 'node_modules' }])
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt'))?.scratchDirs).toEqual(['node_modules'])
  })

  it('refuses anyone but the project\'s owner, and a workspace it does not know, changing nothing', async () => {
    await expect(keepScratchDirsInCheckout(STRANGER, 'wt', ['target'])).rejects.toThrow(/only the owner/)
    await expect(keepScratchDirsInCheckout(OWNER, 'nope', ['target'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt'))?.scratchDirs).toEqual(['node_modules', 'target'])
  })
})
