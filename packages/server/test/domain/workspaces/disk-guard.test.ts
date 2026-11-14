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
import type { NodeDisk } from '@yaac/shared/types'
import { reconcileDiskGuard } from '#domain/workspaces'
import { getWorkspaceRow } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const GiB = 1024 ** 3

let tmpDir: string
let deregistered: string[]
/** What the fake driver answers for every node, with or without trees. */
let disks: NodeDisk[]

const disk = (node: string, freeGiB: number, trees: Array<[string, number]>): NodeDisk => ({
  node, totalBytes: 100 * GiB, freeBytes: freeGiB * GiB, warnBytes: 10 * GiB, stopBytes: 5 * GiB, sharesKubeletDisk: false,
  trees: trees.map(([workspaceId, gib]) => ({ projectId: PROJ, workspaceId, life: 'L1', bytes: gib * GiB })),
})
const running = (...ids: string[]) =>
  snapshotFixture(ids.map((workspaceId) => handleFixture({ workspaceId, projectId: PROJ, jobName: `yaac-proj-${workspaceId}` })))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  deregistered = []
  disks = []
  for (const id of ['big', 'small', 'other', 'full']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id, repos: [] })
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve({ workspaceId: id, projectId: PROJ, unitName: `yaac-proj-${id}` }),
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    nodeDisks: ({ trees }) => Promise.resolve(disks.map((d) => (trees ? d : { ...d, trees: undefined }))),
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('reconcileDiskGuard', () => {
  it('stops the workspace with the largest tree on a node under its stop floor, once, naming the disk', async () => {
    disks = [
      disk('node-a', 3, [['big', 40], ['small', 2]]),
      // Under the warn floor only: nothing is stopped there.
      disk('node-b', 8, [['other', 30]]),
    ]
    await reconcileDiskGuard(running('big', 'small', 'other'))
    await vi.waitFor(async () => {
      expect((await getWorkspaceRow(PROJ, 'big'))?.deathReason).toBe('disk-full')
    })
    expect((await getWorkspaceRow(PROJ, 'big'))?.deathDetail).toMatch(/40\.0 GiB on node node-a, which had 3\.0 GiB free, under the 5\.0 GiB floor/)
    expect(deregistered).toEqual(['big'])
    // The next pass, while that stop lands, picks no second victim for it.
    await reconcileDiskGuard(running('big', 'small', 'other'))
    await new Promise((r) => setTimeout(r, 50))
    expect(deregistered).toEqual(['big'])
    expect((await getWorkspaceRow(PROJ, 'other'))?.deathReason).toBeUndefined()
  })

  it('stops nothing when no tree on the full node is large, or the node cannot be read', async () => {
    disks = [
      disk('node-a', 1, [['small', 0.5]]),
      { ...disk('node-c', 0, [['full', 50]]), error: 'the disk pod could not be asked' },
    ]
    await reconcileDiskGuard(running('small', 'full'))
    await new Promise((r) => setTimeout(r, 50))
    expect(deregistered).toEqual([])
  })
})
