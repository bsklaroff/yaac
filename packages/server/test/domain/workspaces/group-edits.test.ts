import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listProvisioning,
  moveWorkspaceToGroup,
  prepareStart,
  queueWorkspace,
  removeWorkspaceGroup,
  setGroupWorkspaceLimit,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { BUILT_IN_USER_ID, createWorkspaceGroup, getWorkspaceRow, listWorkspaceAgentSessions, listWorkspaceGroupRows } from '#db'
import { getQueuedWorkspaceRow, listQueuedWorkspaceRows } from '#db/queued-workspace-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

// Group writes over a real project and database. What waits for room
// launches through the real create against a fake runtime, so the
// assertions land on which workspaces came up (docs/workspace-groups.md).
// Entries queue in `tui`, whose first prompt is recorded at launch.
let tmpDir: string
let launched: string[]
let groupId: string
/** Workspaces the fake runtime runs; seeded members and launches. */
let runtime: Set<string>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  launched = []
  runtime = new Set()
  installFakeWorkspaceDriver({
    list: () => Promise.resolve([...runtime].map((id) => handleFixture({ workspaceId: id, projectId: PROJ }))),
    launch: (spec) => {
      launched.push(spec.workspaceId)
      runtime.add(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
    },
  })
  ;({ groupId } = await createWorkspaceGroup(PROJ, 'Workers', null))
  await setGroupWorkspaceLimit(PROJ, groupId, 1)
})

afterEach(async () => {
  // No launch may outlive its test's database.
  await vi.waitFor(async () => {
    expect((await listQueuedWorkspaceRows()).filter((r) => r.launchWorkspaceId !== undefined)).toEqual([])
  }, { timeout: 30_000 })
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A workspace the runtime runs, as a create leaves one. */
async function running(workspaceId: string, inGroup?: string): Promise<void> {
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId, ...(inGroup !== undefined ? { groupId: inGroup } : {}) })
  runtime.add(workspaceId)
}

/** The prompts of the workspaces that came up, once `n` have. */
async function launchedPrompts(n: number): Promise<string[]> {
  await vi.waitFor(async () => {
    const prompts = await Promise.all(launched.map(async (id) =>
      (await listWorkspaceAgentSessions(PROJ, id))[0]?.firstPrompt))
    expect(prompts.filter((p) => p !== undefined)).toHaveLength(n)
  }, { timeout: 60_000 })
  return await Promise.all(launched.map(async (id) => (await listWorkspaceAgentSessions(PROJ, id))[0]?.firstPrompt ?? ''))
}

describe('moveWorkspaceToGroup', () => {
  it('refuses a live workspace into a full group, files a stopped one, and moving out frees the slot', async () => {
    await running('member', groupId)
    await running('running')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'stopped' })
    await recordWorkspaceStopped(PROJ, 'stopped')
    const waiting = await queueWorkspace(local, PROJ, { prompt: 'waiting', group: 'Workers', mode: 'tui' }, 'user')

    await expect(moveWorkspaceToGroup(PROJ, 'running', groupId)).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringMatching(/group "Workers" is at its workspace limit of 1 \(running or starting\)/) as string,
    })
    expect((await getWorkspaceRow(PROJ, 'running'))?.groupId).toBeUndefined()
    await moveWorkspaceToGroup(PROJ, 'stopped', groupId)
    expect((await getWorkspaceRow(PROJ, 'stopped'))?.groupId).toBe(groupId)
    expect(launched).toEqual([])

    await moveWorkspaceToGroup(PROJ, 'member', null)
    expect(await launchedPrompts(1)).toEqual(['waiting'])
    // Its record goes once the launch settles, after the prompt lands.
    await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(waiting.id)).toBeUndefined() })
  })

  it('counts a create in flight, and lets only one of two concurrent moves take the last slot', async () => {
    await setGroupWorkspaceLimit(PROJ, groupId, 2)
    for (const id of ['a', 'b']) await running(id)
    await prepareStart(local, {
      projectId: PROJ, workspaceId: 'creating', groupId, mode: 'tui', rememberDefaults: false, claimSpare: false,
    })
    expect(listProvisioning()).toHaveLength(1)

    const outcomes = await Promise.allSettled([
      moveWorkspaceToGroup(PROJ, 'a', groupId),
      moveWorkspaceToGroup(PROJ, 'b', groupId),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('setGroupWorkspaceLimit', () => {
  it('stops nothing when lowered, and launches what waits, oldest first, when raised or cleared', async () => {
    await setGroupWorkspaceLimit(PROJ, groupId, 3)
    for (const id of ['m1', 'm2']) await running(id, groupId)
    await setGroupWorkspaceLimit(PROJ, groupId, 1)
    expect((await listWorkspaceGroupRows(PROJ))[0].workspaceLimit).toBe(1)
    expect((await getWorkspaceRow(PROJ, 'm2'))?.stoppedAt).toBeUndefined()

    for (const prompt of ['first', 'second', 'third']) {
      await queueWorkspace(local, PROJ, { prompt, group: groupId, mode: 'tui' }, 'user')
    }
    // Two live already: room for one more only at three, however many
    // writes race to fill it, since a launch takes its slot before it claims.
    await Promise.all([1, 2, 3].map(() => setGroupWorkspaceLimit(PROJ, groupId, 3)))
    expect(await launchedPrompts(1)).toEqual(['first'])
    await new Promise((r) => setTimeout(r, 200))
    expect(launched).toHaveLength(1)

    await setGroupWorkspaceLimit(PROJ, groupId, null)
    expect((await launchedPrompts(3)).sort()).toEqual(['first', 'second', 'third'])
    expect((await listWorkspaceGroupRows(PROJ))[0].workspaceLimit).toBeNull()
  })

  it('refuses a group the project does not have', async () => {
    await expect(setGroupWorkspaceLimit(PROJ, 'nope', 2)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // The failed create's row lingers until its rollback, but its runtime is
  // gone, so the slot is free as soon as the launch fails.
  it('launches the next waiting entry once a launch into the group fails', async () => {
    let fail!: () => void
    const failing = new Promise<void>((resolve) => { fail = resolve })
    let first = true
    installFakeWorkspaceDriver({
      list: () => Promise.resolve([...runtime].map((id) => handleFixture({ workspaceId: id, projectId: PROJ }))),
      launch: async (spec) => {
        launched.push(spec.workspaceId)
        if (first) {
          first = false
          await failing
          throw new Error('no capacity')
        }
        runtime.add(spec.workspaceId)
        return handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ })
      },
    })
    await setGroupWorkspaceLimit(PROJ, groupId, 2)
    await running('member', groupId)
    await queueWorkspace(local, PROJ, { prompt: 'fails', group: groupId, mode: 'tui' }, 'user')
    await vi.waitFor(() => { expect(launched).toHaveLength(1) }, { timeout: 30_000 })
    const next = await queueWorkspace(local, PROJ, { prompt: 'next', group: groupId, mode: 'tui' }, 'user')
    expect(launched).toHaveLength(1)

    fail()
    await vi.waitFor(async () => {
      expect(await Promise.all(launched.map(async (id) => (await listWorkspaceAgentSessions(PROJ, id))[0]?.firstPrompt)))
        .toContain('next')
    }, { timeout: 60_000 })
    await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(next.id)).toBeUndefined() })
  })
})

describe('removeWorkspaceGroup', () => {
  it('moves what waits for room to the default list, where it launches', async () => {
    await running('member', groupId)
    const waiting = await queueWorkspace(local, PROJ, { prompt: 'waiting', group: groupId, mode: 'tui' }, 'user')

    await removeWorkspaceGroup(PROJ, groupId)
    expect(await launchedPrompts(1)).toEqual(['waiting'])
    // Its record goes once the launch settles, after the prompt lands.
    await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(waiting.id)).toBeUndefined() })
    expect((await getWorkspaceRow(PROJ, launched[0]))?.groupId).toBeUndefined()
  })
})
