import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'

// A stop's detached teardown is a spawned shell; it exits at once.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: ChildProcessModule.SpawnOptions) => {
      if (cmd !== 'sh') return actual.spawn(cmd, args, opts)
      const child = Object.assign(new EventEmitter(), { unref: () => { /* detached */ } })
      setImmediate(() => child.emit('exit', 0))
      return child
    },
  }
})
import { queueWorkspace, reconcileWorkspaceTimeouts, setWorkspaceTimeout } from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import { getQueuedWorkspaceRow } from '#db/queued-workspace-store'
import { BUILT_IN_USER_ID, getWorkspaceRow } from '#db'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { _clearTerminatingForTests } from '#runtime/status/terminating'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
/** Workspaces the driver tore down, and the ones it launched. */
let deregistered: string[]
let launched: string[]

const past = (): Date => new Date(Date.now() - 60_000)
const running = (...ids: string[]) =>
  snapshotFixture(ids.map((workspaceId) => handleFixture({ workspaceId, projectId: PROJ })))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  _clearTerminatingForTests()
  deregistered = []
  launched = []
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve({ workspaceId: id, projectId: PROJ, unitName: `yaac-proj-${id}` }),
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
    },
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('reconcileWorkspaceTimeouts', () => {
  it('stops a running workspace past its deadline as a natural stop, so what was queued after it starts', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'timed', deadline: past() })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'later', deadline: new Date(Date.now() + 3_600_000) })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'untimed' })
    const child = await queueWorkspace(local, PROJ, { parent: 'timed', prompt: 'follow up', tool: 'claude' }, 'user')

    await reconcileWorkspaceTimeouts(running('timed', 'later', 'untimed'))
    expect(deregistered).toEqual(['timed'])
    await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined() }, { timeout: 60_000 })
    expect(launched).toHaveLength(1)
  })

  it('leaves alone a create still provisioning, one already going away, and one not running', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'creating', deadline: past() })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'going', deadline: past() })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'gone', deadline: past() })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'stopped', deadline: past() })
    await recordWorkspaceStopped(PROJ, 'stopped')
    registerProvisioning({ workspaceId: 'creating', projectId: PROJ, tool: 'claude', kind: 'create' })

    await reconcileWorkspaceTimeouts(snapshotFixture([
      handleFixture({ workspaceId: 'creating', projectId: PROJ }),
      handleFixture({ workspaceId: 'going', projectId: PROJ, terminating: true }),
      handleFixture({ workspaceId: 'stopped', projectId: PROJ }),
    ]))
    expect(deregistered).toEqual([])

    // Once its create is done, the next resync stops it.
    clearAllProvisioningForTests()
    await reconcileWorkspaceTimeouts(running('creating'))
    expect(deregistered).toEqual(['creating'])
  })
})

describe('setWorkspaceTimeout', () => {
  it('sets a running workspace\'s deadline from now or clears it, and refuses a stopped one', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-running' })
    const before = Date.now()
    const set = await setWorkspaceTimeout(local, 'ws-run', 90)
    expect(set.workspaceId).toBe('ws-running')
    const deadline = new Date(set.deadline ?? '').getTime()
    expect(deadline).toBeGreaterThanOrEqual(before + 90 * 60_000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 90 * 60_000)
    expect((await getWorkspaceRow(PROJ, 'ws-running'))?.deadline?.getTime()).toBe(deadline)

    expect(await setWorkspaceTimeout(local, 'ws-running', null)).toEqual({ workspaceId: 'ws-running', deadline: null })
    expect((await getWorkspaceRow(PROJ, 'ws-running'))?.deadline).toBeUndefined()

    await recordWorkspaceStopped(PROJ, 'ws-running')
    await expect(setWorkspaceTimeout(local, 'ws-running', 30)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(setWorkspaceTimeout({ kind: 'local', userId: '5b1c9d3e-2f0a-4e6b-9c7d-8a1e2f3b4c5d' }, 'ws-running', 30))
      .rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) as string })
  })
})
