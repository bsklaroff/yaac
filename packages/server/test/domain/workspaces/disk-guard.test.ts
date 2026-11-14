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

const disk = (node: string, freeGiB: number, trees: Array<[string, number, string?]>): NodeDisk => ({
  node, totalBytes: 100 * GiB, freeBytes: freeGiB * GiB, warnBytes: 10 * GiB, stopBytes: 5 * GiB, sharesKubeletDisk: false,
  trees: trees.map(([workspaceId, gib, life]) => ({ projectId: PROJ, workspaceId, life: life ?? 'L1', bytes: gib * GiB })),
})
/** Workspaces the runtime shows, each on a node: running unless marked. */
const view = (...units: Array<[string, string, 'terminating'?]>) =>
  snapshotFixture(units.map(([workspaceId, node, t]) => handleFixture({
    workspaceId, projectId: PROJ, jobName: `yaac-proj-${workspaceId}`, node,
    ...(t ? { terminating: true } : {}),
  })))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  deregistered = []
  disks = []
  // Each workspace's current life fills the tree named L1.
  for (const id of ['big', 'small', 'other', 'full', 'moved', 'stale']) {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id, repos: [], treeDir: 'L1' })
  }
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

describe('reconcileDiskGuard', () => {
  it('stops the workspace filling the largest tree on a node under its stop floor, one stop at a time, naming the disk', async () => {
    disks = [
      // A tree an earlier life left, and one of a workspace now running on
      // another node, are larger but are not what fills this node now.
      disk('node-a', 3, [['stale', 60, 'L0'], ['moved', 50], ['big', 40], ['small', 2]]),
      // Under the warn floor only: nothing is stopped there.
      disk('node-b', 8, [['other', 30]]),
    ]
    const units: Array<[string, string]> = [['stale', 'node-a'], ['moved', 'node-b'], ['big', 'node-a'], ['small', 'node-a'], ['other', 'node-b']]
    await reconcileDiskGuard(view(...units))
    await vi.waitFor(async () => {
      expect((await getWorkspaceRow(PROJ, 'big'))?.deathReason).toBe('disk-full')
    })
    expect((await getWorkspaceRow(PROJ, 'big'))?.deathDetail).toMatch(/40\.0 GiB on node node-a, which had 3\.0 GiB free, under the 5\.0 GiB floor/)
    expect(deregistered).toEqual(['big'])
    // While that stop lands (the runtime shows it terminating, its tree
    // still listed) the node gets no second stop.
    await reconcileDiskGuard(view(['stale', 'node-a'], ['moved', 'node-b'], ['big', 'node-a', 'terminating'], ['small', 'node-a'], ['other', 'node-b']))
    await settle()
    expect(deregistered).toEqual(['big'])
    // Once it is gone, a node still under the floor gets the next.
    disks = [disk('node-a', 3, [['stale', 60, 'L0'], ['small', 2]])]
    await reconcileDiskGuard(view(['stale', 'node-a'], ['small', 'node-a']))
    await vi.waitFor(() => { expect(deregistered).toEqual(['big', 'small']) })
  })

  it('stops nothing when no tree on the full node is large, its trees were not all measured, or it cannot be read', async () => {
    disks = [
      disk('node-a', 1, [['small', 0.5]]),
      { ...disk('node-b', 1, [['other', 30]]), truncated: true },
      { ...disk('node-c', 0, [['full', 50]]), error: 'the disk pod could not be asked' },
    ]
    await reconcileDiskGuard(view(['small', 'node-a'], ['other', 'node-b'], ['full', 'node-c']))
    await settle()
    expect(deregistered).toEqual([])
  })
})
