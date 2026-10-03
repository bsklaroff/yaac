import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { queueWorkspace, stopWorkspace } from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { getQueuedWorkspaceRow } from '#db/queued-workspace-store'
import { getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'

// A stop runs the (fake) driver's teardown, then creates whatever was queued
// after the stopped workspace. Both run for real, over a real project.
let tmpDir: string
/** Workspaces the driver tore down, and the ones it launched. */
let deregistered: string[]
let launched: string[]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject('proj')
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  deregistered = []
  launched = []
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve(id === 'parent'
      ? { workspaceId: 'parent', projectSlug: 'proj', unitName: 'yaac-proj-parent' }
      : undefined),
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectSlug: 'proj' }))
    },
  })
  await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'parent', baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** The workspace whose first conversation began with `prompt`. */
async function launchedWith(prompt: string): Promise<string | undefined> {
  for (const id of launched) {
    if ((await listWorkspaceAgentSessions('proj', id))[0]?.firstPrompt === prompt) return id
  }
  return undefined
}

describe('stopWorkspace', () => {
  // A stop never asks the driver for spares, so even a spare's exact id is
  // not found.
  it('does not stop an unclaimed spare, even by its exact id', async () => {
    const asked: Array<{ spares?: boolean } | undefined> = []
    installFakeWorkspaceDriver({
      findForTeardown: (id, opts) => {
        asked.push(opts)
        return Promise.resolve(id === 'spare1' && opts?.spares === true
          ? { workspaceId: 'spare1', projectSlug: 'proj', unitName: 'yaac-proj-spare1' }
          : undefined)
      },
    })
    await expect(stopWorkspace('spare1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked).toEqual([undefined])
    expect(deregistered).toEqual([])
  })

  it('tears the workspace down, then starts what was queued after it — only the top of a chain', async () => {
    const child = await queueWorkspace('proj', { parent: 'parent', prompt: 'child', tool: 'claude' }, 'user')
    const sibling = await queueWorkspace('proj', { parent: 'parent', prompt: 'sibling', tool: 'claude' }, 'user')
    const grandchild = await queueWorkspace('proj', { parent: child.id, prompt: 'grandchild' }, 'user')

    // Addressed by a prefix, which the rows expand.
    expect(await stopWorkspace('par')).toMatchObject({ workspaceId: 'parent', projectSlug: 'proj' })
    expect(deregistered).toEqual(['parent'])

    // Both direct children start from their stored settings: the parent's
    // branch, posture and UI mode.
    await vi.waitFor(async () => {
      expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined()
      expect(await getQueuedWorkspaceRow(sibling.id)).toBeUndefined()
    }, { timeout: 60_000 })
    expect(launched).toHaveLength(2)
    const becameId = await launchedWith('child')
    expect(await launchedWith('sibling')).toBeDefined()
    expect(await getWorkspaceRow('proj', becameId!)).toMatchObject({ baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
    // The grandchild now waits for the child's new workspace to stop.
    const waiting = await getQueuedWorkspaceRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorkspaceId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  it('refuses a workspace with nothing running', async () => {
    await expect(stopWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
