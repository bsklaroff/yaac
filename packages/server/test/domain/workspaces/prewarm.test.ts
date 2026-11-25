import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { reconcilePrewarmPool } from '#domain/workspaces'
import { clearPrewarmStateForTests, takeSpareFor } from '#domain/workspaces/prewarm'
import { WORKSPACE_RESOURCES } from '#domain/workspaces/create'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { setProjectScratchDirs } from '#db/project-store'
import { closeDb } from '#db/client'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import type { SpareUnit, WorkspaceDriver } from '#drivers/contract'

const A = 'a0a0a0a0-0000-4000-8000-00000000000a'
const B = 'b0b0b0b0-0000-4000-8000-00000000000b'
const C = 'c0c0c0c0-0000-4000-8000-00000000000c'
const IDLE = 'd0d0d0d0-0000-4000-8000-00000000000d'

const GIB = 1024 ** 3
/** What a project on the stock image launches, under the fake driver. */
const STOCK = 'registry.test/fake-tools:t'

let tmpDir: string
/** What the runtime lists as spares on the next pass. */
let spares: SpareUnit[]
let warmed: Array<Parameters<WorkspaceDriver['warmSpare']>[0]>
let reaped: string[]
/** The reaps asked to leave a spare a start takes meanwhile. */
let ifSpare: string[]
let takes: Array<Parameters<WorkspaceDriver['takeSpare']>[0]>
const warmSpare = vi.fn<WorkspaceDriver['warmSpare']>()

/** A spare of the stock image, listed up and made after this server
 *  started unless a case says otherwise. */
function spare(workspaceId: string, over: Partial<SpareUnit> = {}): SpareUnit {
  return {
    workspaceId, jobName: `yaac-${workspaceId}`, image: STOCK, scratchBytes: 32 * GIB,
    createdAtMs: Date.now(), ready: true, failed: false, orphaned: false, ...over,
  }
}

/** The pools asked for so far, as image and size in GiB. */
const pools = (): string[] => warmed.map((w) => `${w.image} ${String(w.scratchBytes / GIB)}`).sort()

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearPrewarmStateForTests()
  spares = []
  warmed = []
  reaped = []
  ifSpare = []
  takes = []
  let n = 0
  warmSpare.mockReset().mockImplementation((args) => {
    warmed.push(args)
    return Promise.resolve(`warm-${String(n += 1)}`)
  })
  installFakeWorkspaceDriver({
    listSpares: () => Promise.resolve(spares),
    warmSpare,
    reapSpare: (id, opts) => {
      reaped.push(id)
      if (opts?.ifSpare === true) ifSpare.push(id)
      return Promise.resolve()
    },
    takeSpare: (args) => { takes.push(args); return Promise.resolve('taken-1') },
  })
  // A and B share a scratch size, C has its own, and IDLE's only
  // workspace stopped two days ago.
  for (const id of [A, B, C, IDLE]) {
    await recordTestProject(id)
    await recordWorkspaceCreated({ projectId: id, workspaceId: `w-${id}` })
  }
  await setProjectScratchDirs(C, { sizeGiB: 8 })
  await setProjectScratchDirs(IDLE, { sizeGiB: 4 })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 2 * 24 * 60 * 60_000 })
  await recordWorkspaceStopped(IDLE, `w-${IDLE}`)
  vi.useRealTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  clearPrewarmStateForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('reconcilePrewarmPool', () => {
  // A workspace stopped within the day keeps its pool, so a quick restart
  // or the next create of the project finds one.
  it('keeps one pool per image and scratch size that a workspace running or stopped within a day uses', async () => {
    await recordWorkspaceStopped(B, `w-${B}`)

    await reconcilePrewarmPool()

    expect(pools()).toEqual([`${STOCK} 32`, `${STOCK} 8`])
    expect(warmed.every((w) => w.resources === WORKSPACE_RESOURCES)).toBe(true)
    expect(reaped).toEqual([])

    // A larger pool asks for that many of each.
    clearPrewarmStateForTests()
    warmed = []
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    await reconcilePrewarmPool()
    expect(pools()).toEqual([`${STOCK} 32`, `${STOCK} 32`, `${STOCK} 8`, `${STOCK} 8`])
  })

  // A spare is counted from the moment it is asked for, until its pod
  // lists or a minute passes; a warm that fails is asked for again.
  it('counts a spare asked for until it lists, so passes never over-warm', async () => {
    await setProjectScratchDirs(C, { sizeGiB: 32 })
    const asked = (): number => warmSpare.mock.calls.length
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now })
    await reconcilePrewarmPool()
    expect(asked()).toBe(1)

    // Still warming, then listed: nothing more either way.
    await reconcilePrewarmPool()
    spares = [spare('warm-1')]
    await reconcilePrewarmPool()
    expect(asked()).toBe(1)

    // Taken, so the pool is short again.
    spares = []
    await reconcilePrewarmPool()
    expect(asked()).toBe(2)

    // One asked for that never lists counts only for the grace minute.
    vi.setSystemTime(now + 30_000)
    await reconcilePrewarmPool()
    expect(asked()).toBe(2)
    vi.setSystemTime(now + 61_000)
    await reconcilePrewarmPool()
    expect(asked()).toBe(3)

    // One the runtime refused is asked for at the next pass.
    warmSpare.mockRejectedValueOnce(new Error('no ready node'))
    vi.setSystemTime(now + 200_000)
    await reconcilePrewarmPool()
    expect(asked()).toBe(4)
    await reconcilePrewarmPool()
    expect(asked()).toBe(5)
  })

  it('reaps a spare that ended, one a dead server took, one older than this server, one no pool wants, and the oldest of one too many', async () => {
    const now = Date.now()
    spares = [
      spare('failed', { failed: true, ready: false }),
      spare('orphaned', { orphaned: true }),
      spare('before-start', { createdAtMs: 1 }),
      spare('other-image', { image: 'registry.test/fake-user-x:t.1' }),
      spare('other-size', { scratchBytes: 4 * GIB }),
      spare('older', { createdAtMs: now }),
      spare('newer', { createdAtMs: now + 1_000 }),
      spare('eight', { scratchBytes: 8 * GIB }),
    ]

    await reconcilePrewarmPool()

    expect(reaped.sort()).toEqual(['before-start', 'failed', 'older', 'orphaned', 'other-image', 'other-size'])
    // One still a spare goes only if no start takes it first.
    expect(ifSpare.sort()).toEqual(['before-start', 'older', 'other-image', 'other-size'])
    expect(warmed).toEqual([])
  })

  // A spare's Job whose pod is not made yet is still being asked for: its
  // pool is not known, so it is neither reaped nor counted as listed.
  it('leaves a pending spare out of the plan, still counting it as asked for', async () => {
    await setProjectScratchDirs(C, { sizeGiB: 32 })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    await reconcilePrewarmPool()
    expect(warmSpare).toHaveBeenCalledTimes(1)
    spares = [spare('warm-1', { image: '', scratchBytes: 0, ready: false, pending: true })]
    await reconcilePrewarmPool()
    expect(reaped).toEqual([])
    expect(warmSpare).toHaveBeenCalledTimes(1)
  })

  // docs/legacy-compat-shims.md "Per-project spares of an older server"
  it('reaps an older server\'s per-project spare, its Job before its files, and leaves one with a row', async () => {
    const files = workspaceDir(A, 'old-spare')
    await fs.mkdir(path.join(files, 'src'), { recursive: true })
    await fs.writeFile(path.join(files, 'src', 'f'), 'x')
    const older = { image: '', scratchBytes: 0, ready: false, projectId: A }
    spares = [spare('old-spare', older), spare(`w-${B}`, { ...older, projectId: B })]
    // The pod holds files open until its Job is gone, so they must still be
    // there when the Job is reaped.
    let filesAtReap: boolean | undefined
    installFakeWorkspaceDriver({
      listSpares: () => Promise.resolve(spares),
      warmSpare,
      reapSpare: async (id) => {
        filesAtReap = await fs.access(path.join(files, 'src')).then(() => true, () => false)
        reaped.push(id)
      },
    })

    await reconcilePrewarmPool()

    await vi.waitFor(() => { expect(reaped).toEqual(['old-spare']) })
    expect(filesAtReap).toBe(true)
    expect(ifSpare).toEqual([])
    await vi.waitFor(() => expect(fs.access(path.join(files, 'src'))).rejects.toThrow())
    // Not a spare of any pool, so the pools are warmed as without it.
    expect(pools()).toEqual([`${STOCK} 32`, `${STOCK} 8`])
  })

  it('reaps every spare, and warms none, with pools turned off', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    spares = [spare('one'), spare('eight', { scratchBytes: 8 * GIB })]

    await reconcilePrewarmPool()

    expect(reaped.sort()).toEqual(['eight', 'one'])
    expect(warmed).toEqual([])
  })

  // A pod starting beside a claim slows it, so the pool waits until every
  // start that took a spare has opened its windows; it still reaps.
  it('warms nothing while a start that took a spare is under way', async () => {
    const take = await takeSpareFor(A, undefined)
    expect(take?.id).toBe('taken-1')
    // Only a spare this process made, on this build, can be taken.
    expect(takes).toEqual([{ image: STOCK, scratchBytes: 32 * GIB, madeSince: expect.any(Number) as number }])
    expect(takes[0].madeSince).toBeLessThanOrEqual(Date.now())
    spares = [spare('other-size', { scratchBytes: 4 * GIB })]

    await reconcilePrewarmPool()
    expect(reaped).toEqual(['other-size'])
    expect(warmed).toEqual([])

    take?.done()
    take?.done()
    await reconcilePrewarmPool()
    expect(pools()).toEqual([`${STOCK} 32`, `${STOCK} 8`])
  })
})
