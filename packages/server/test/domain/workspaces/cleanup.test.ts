import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as dbModule from '#db'

const PROJ_A = '35f146e4-c6e4-40e3-8dcf-ae8471558e9f'
const PROJ_B = '59f56625-001b-4df1-8d07-9b32191dc0a0'

vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return {
    ...actual,
    // Real, but a test can make the project list unreadable.
    listProjectRows: vi.fn(actual.listProjectRows),
  }
})
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { gcOrphanEphemeralModuleDirs, reapOrphanNodeLocal } from '#domain/workspaces'
import { setDataDir, workspaceDir } from '@yaac/shared/project-paths'
import type { NodeLocalLiveSet, RuntimeSnapshot, StrayUnit, RuntimeHandle } from '#drivers/contract'
import { BUILT_IN_USER_ID, closeDb, listProjectRows } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordProject } from '#db/project-store'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'

let gcDataDir: string

/** Register ids as in-flight creates in the real registry. */
function publishInFlight(provisioning: string[] = []): void {
  clearAllProvisioningForTests()
  for (const workspaceId of provisioning) {
    registerProvisioning({ workspaceId, projectId: PROJ_A, tool: 'claude', kind: 'create' })
  }
}

/** Live sets passed to the runtime's node-local reap. */
let reaped: NodeLocalLiveSet[]
/** The pass view the sweeps are handed. */
let view: RuntimeSnapshot

/** A pass view reporting these workspaces and stray units. */
function seeRunning(workspaces: RuntimeHandle[], strays: StrayUnit[] = []): void {
  view = snapshotFixture(workspaces, strays)
}

/** A pass view that cannot be read. */
function seeNothing(): void {
  view = {
    resync: true,
    workspaces: () => Promise.reject(new Error('cluster offline')),
    strayUnits: () => Promise.reject(new Error('cluster offline')),
  }
}

async function setUpSweep(): Promise<void> {
  gcDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
  setDataDir(gcDataDir)
  reaped = []
  installFakeWorkspaceDriver({
    reapNodeLocal: (live) => { reaped.push(live); return Promise.resolve() },
  })
  seeRunning([])
  publishInFlight()
}

async function tearDownSweep(): Promise<void> {
  clearAllProvisioningForTests()
  await closeDb()
  await fs.rm(gcDataDir, { recursive: true, force: true })
}

// Backdated, since the sweep spares anything written around its own start
// (a create staging into it).
const STALE = new Date(Date.now() - 3_600_000)

async function seedModulesDir(projectId: string, sid: string): Promise<string> {
  const dir = path.join(gcDataDir, 'node-local', 'projects', projectId, '.cached-packages', 'modules', sid)
  await fs.mkdir(dir, { recursive: true })
  await fs.utimes(dir, STALE, STALE)
  return dir
}

async function seedWorkspacesDir(projectId: string, sid: string): Promise<string> {
  const dir = path.join(gcDataDir, 'global', 'projects', projectId, 'sessions', sid)
  await fs.mkdir(dir, { recursive: true })
  await fs.utimes(dir, STALE, STALE)
  return dir
}

describe('gcOrphanEphemeralModuleDirs', () => {
  beforeEach(setUpSweep)
  afterEach(tearDownSweep)

  it('removes orphan per-session dirs and leaves node-local ones to the runtime', async () => {
    const liveTmux = await seedWorkspacesDir(PROJ_A, 'live-1')
    const deadTmux = await seedWorkspacesDir(PROJ_A, 'dead-1')
    const deadModules = await seedModulesDir(PROJ_A, 'dead-1')

    seeRunning([handleFixture({ workspaceId: 'live-1', projectId: PROJ_A })])

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(liveTmux)).resolves.toBeUndefined()
    await expect(fs.access(deadTmux)).rejects.toThrow()
    await expect(fs.access(deadModules)).resolves.toBeUndefined()
    expect(reaped).toHaveLength(0)
  })

  // On disk a dead spare's checkout and a stopped workspace's look the same,
  // and after a database restore a claimed workspace may have no row, so
  // this sweep keeps every checkout (`reapSpare` removes a spare's). A dir
  // under projects/ that is no project id (an older install's slug) is
  // still swept.
  it('keeps every checkout, with a row or without', async () => {
    const slugSession = await seedWorkspacesDir('demo', 'dead-2')
    await recordWorkspaceCreated({ projectId: PROJ_A, workspaceId: 'stopped-1' })
    const checkouts = await Promise.all(['rowless-1', 'stopped-1'].map(async (sid) => {
      const dir = workspaceDir(PROJ_A, sid)
      await fs.mkdir(dir, { recursive: true })
      await fs.utimes(dir, STALE, STALE)
      return dir
    }))

    await gcOrphanEphemeralModuleDirs(view)

    for (const dir of checkouts) await expect(fs.access(dir)).resolves.toBeUndefined()
    await expect(fs.access(slugSession)).rejects.toThrow()
  })

  it('spares a session the process is still provisioning', async () => {
    // The create records its row before anything is launched, so no
    // listing shows it yet; sweeping would delete dirs it is about to mount.
    const staging = await seedWorkspacesDir(PROJ_A, 'creating-1')
    publishInFlight(['creating-1'])

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(staging)).resolves.toBeUndefined()
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // The same race for a create with no provisioning row (a spare's warm):
    // a fresh dir is left for the next sweep.
    const fresh = await seedWorkspacesDir(PROJ_A, 'staging-1')
    await fs.utimes(fresh, new Date(), new Date())

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })

  // An unreadable view must not read as empty.
  it('fails without removing anything when the runtime view cannot be read', async () => {
    const dead = await seedWorkspacesDir(PROJ_A, 'would-be-removed')
    seeNothing()

    await expect(gcOrphanEphemeralModuleDirs(view)).rejects.toThrow('cluster offline')
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })
})

describe('reapOrphanNodeLocal', () => {
  beforeEach(setUpSweep)
  afterEach(tearDownSweep)

  // Node-local dirs may live on another node, so the runtime removes them.
  // This layer only hands over the live set: recorded project ids,
  // workspaces, stray units and in-flight creates.
  it('hands the runtime the live project ids and workspaces, and removes no node-local dir itself', async () => {
    await recordProject({ id: PROJ_A, name: 'demo', remoteUrl: 'https://x/proj-a', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: PROJ_B, name: 'demo', remoteUrl: 'https://x/proj-b', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    const ids = (await listProjectRows()).map((r) => r.id)
    const live = await seedModulesDir(ids[0], 'live-1')
    const dead = await seedModulesDir(ids[0], 'dead-1')
    const strayOnly = await seedModulesDir(ids[1], 'job-only-1')
    const orphan = await seedModulesDir('removed-project', 'x')
    publishInFlight(['creating-1'])

    seeRunning(
      [handleFixture({ workspaceId: 'live-1', projectId: PROJ_A })],
      // A unit mid-recreate appears only as a stray, and its replacement is
      // about to mount its dirs.
      [{ workspaceId: 'job-only-1', unitName: 'yaac-proj-b-job-only-1', projectId: PROJ_B, createdAtMs: 0, prewarmed: false }],
    )

    await reapOrphanNodeLocal(view)

    expect(reaped).toEqual([{
      projectIds: new Set(ids),
      workspaceIds: new Set(['live-1', 'job-only-1', 'creating-1']),
    }])
    for (const dir of [live, dead, strayOnly, orphan]) {
      await expect(fs.access(dir)).resolves.toBeUndefined()
    }
  })

  // No project is live, so every node-local tree is an orphan.
  it('with no projects, hands the runtime an empty live set', async () => {
    await reapOrphanNodeLocal(view)
    expect(reaped).toEqual([{ projectIds: new Set(), workspaceIds: new Set() }])
  })

  // An empty list would make every tree look orphaned, so an unreadable
  // projects list or view fails the step instead.
  it('hands the runtime nothing when its records cannot be read', async () => {
    vi.mocked(listProjectRows).mockRejectedValueOnce(new Error('db closed'))
    await expect(reapOrphanNodeLocal(view)).rejects.toThrow('db closed')

    seeNothing()
    await expect(reapOrphanNodeLocal(view)).rejects.toThrow('cluster offline')
    expect(reaped).toHaveLength(0)
  })
})
