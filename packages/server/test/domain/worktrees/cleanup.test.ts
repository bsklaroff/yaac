import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as dbModule from '#db'

vi.mock('#db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  applyWorktreeEvent: vi.fn(),
}))
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type ChildProcessModule from 'node:child_process'

const spawnMock = vi.fn<(cmd: string, args: string[], opts: unknown) => void>()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnMock(cmd, args, opts)
      return { unref: () => { /* detached stub */ } }
    },
  }
})

// Audit logging is a vi.fn so the teardown line can be asserted without a
// real server.log on disk.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  _resetOrphanModulesSweepForTests,
  cleanupWorktree,
  cleanupWorktreeDetached,
  deleteWorktreeState,
  gcOrphanEphemeralModuleDirs,
  worktreeModulesDir,
} from '#domain/worktrees/cleanup'

import { isWorktreeTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#runtime/status/liveness'
import { _resetWorktreeStatusStoreForTests } from '#runtime/status/status-store'
import { serverLog } from '#log'
import { setDataDir, worktreeStateRoots } from '@yaac/shared/project-paths'
import type { WorktreeEvent } from '#db'
import { applyWorktreeEvent } from '#db'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/worktrees/provisioning'
import {
  handleFixture,
  installFakeWorktreeDriver,
  snapshotFixture,
} from '@yaac/test-utils/fake-driver'
import {
  WorkspaceExecError,
  type RuntimeHandle,
  type StrayUnit,
  type TeardownTarget,
  type WorktreeDriver,
} from '#drivers/contract'

const mockServerLog = vi.mocked(serverLog)

// Cleanup reports the stop as an event rather than writing the row itself,
// so applyWorktreeEvent is stubbed: these tests never open a DB, and what a
// teardown says is asserted directly.
const appliedEvents: WorktreeEvent[] = []
vi.mocked(applyWorktreeEvent).mockImplementation((event) => {
  appliedEvents.push(event)
  return Promise.resolve()
})
const clearWorktreeEvents = (): void => { appliedEvents.length = 0 }
const stopsReported = (): Array<[string, string, unknown]> => appliedEvents
  .filter((e) => e.type === 'worktree-stopped')
  .map((e) => [e.projectSlug, e.worktreeId, e.cause])

/**
 * What the mediator asked the runtime to do, in the order it asked.
 *
 * The runtime's own sequencing (deregister, salvage, delete) is
 * asserted in `test/drivers/k8s/worktrees/teardown.test.ts`, where it lives.
 * What these tests own is the half above it: what the mediator records and
 * evicts before handing over, what it composes around the runtime's shell
 * command, and how it treats the verdict it gets back.
 */
interface RuntimeCalls {
  destroyed: TeardownTarget[]
  deregistered: string[]
  salvaged: TeardownTarget[]
  /** Resolved by `salvageImages`, so a test can hold the chain open. */
  releaseSalvage: () => void
}

const TEARDOWN_SENTINEL = 'runtime-teardown-here'

/** Install a runtime whose teardown verbs record rather than act. */
function installRuntime(opts: {
  destroy?: (target: TeardownTarget) => Promise<boolean>
  blockSalvage?: boolean
} = {}): RuntimeCalls {
  const calls: RuntimeCalls = {
    destroyed: [], deregistered: [], salvaged: [], releaseSalvage: () => { /* replaced below */ },
  }
  let release = (): void => { /* set per call */ }
  calls.releaseSalvage = () => { release() }
  installFakeWorktreeDriver({
    destroy: (target) => {
      calls.destroyed.push(target)
      return opts.destroy ? opts.destroy(target) : Promise.resolve(true)
    },
    deregisterWorkspace: (id) => { calls.deregistered.push(id); return Promise.resolve() },
    salvageImages: (target) => {
      calls.salvaged.push(target)
      if (!opts.blockSalvage) return Promise.resolve()
      return new Promise<void>((resolve) => { release = resolve })
    },
    detachedTeardownCommand: () => TEARDOWN_SENTINEL,
  })
  return calls
}

/** The script the detached teardown handed to `sh -c`. */
function spawnedScript(): string | undefined {
  const call = spawnMock.mock.calls.find(([cmd]) => cmd === 'sh')
  return call ? call[1][1] : undefined
}

describe('cleanupWorktree', () => {
  let runtime: RuntimeCalls

  beforeEach(() => {
    clearWorktreeEvents()
    runtime = installRuntime()
  })

  it('hands the runtime the workspace to destroy, and relays its verdict', async () => {
    await expect(cleanupWorktree({
      jobName: 'yaac-p-s-casc', projectSlug: 'p', worktreeId: 's-casc',
    })).resolves.toBe(true)

    expect(runtime.destroyed).toEqual([
      { projectSlug: 'p', workspaceId: 's-casc', unitName: 'yaac-p-s-casc' },
    ])
  })

  // Callers chain `deleteWorktreeState` off this, so a runtime the driver
  // could not confirm gone has to read as "not gone" all the way up: what
  // is still shutting down is still writing to /workspace.
  it('reports NOT gone when the runtime could not confirm the teardown', async () => {
    runtime = installRuntime({ destroy: () => Promise.resolve(false) })

    await expect(cleanupWorktree({
      jobName: 'yaac-p-s-slow', projectSlug: 'p', worktreeId: 's-slow',
    })).resolves.toBe(false)
  })

  // Reaches across the seal on purpose. The liveness caches are keyed by
  // (slug, worktreeId) and process-global, so a teardown that forgot to evict
  // them leaves a restarted session reading its predecessor's verdict — and
  // nothing about that failure is loud. Asserting `forgetLiveness` in
  // liveness.test.ts only proves the function works, not that cleanup calls it.
  it('evicts the liveness cache so a reused session id cannot read a stale verdict', async () => {
    _clearTmuxAliveCacheForTests()
    _resetWorktreeStatusStoreForTests()

    const target = { projectSlug: 'p', workspaceId: 's-stale', jobName: 'yaac-p-s-stale' }
    const exec = vi.fn<WorktreeDriver['exec']>()
      .mockResolvedValue({ stdout: '', stderr: '' })
    installFakeWorktreeDriver({ exec })

    await expect(probeTmuxLiveness(target)).resolves.toBe('alive')
    expect(exec).toHaveBeenCalledTimes(1)

    // Within the TTL a second probe would be served from cache — teardown is
    // what has to invalidate it.
    await cleanupWorktree({ jobName: 'yaac-p-s-stale', projectSlug: 'p', worktreeId: 's-stale' })

    exec.mockRejectedValue(new WorkspaceExecError('exit 1', 1, '', "can't find session: yaac"))
    await expect(probeTmuxLiveness(target)).resolves.toBe('dead')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reports the death cause with the stop', async () => {
    await cleanupWorktree({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'p',
      worktreeId: 's-cause',
      cause: { reason: 'crashed', detail: 'exit code 1' },
    })
    expect(stopsReported()).toEqual([
      ['p', 's-cause', { reason: 'crashed', detail: 'exit code 1' }],
    ])
  })

  // The mount sources belong to a workspace that may still be running: a
  // teardown that removed them first would pull /workspace's neighbours out
  // from under a container still shutting down.
  it('removes the workspace dirs only once the runtime is gone', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-order-'))
    setDataDir(dataDir)
    try {
      const modules = worktreeModulesDir('p', 's-dirs')
      await fs.mkdir(modules, { recursive: true })
      let existedDuringDestroy: boolean | undefined
      installRuntime({
        destroy: async () => {
          existedDuringDestroy = await fs.access(modules).then(() => true, () => false)
          return true
        },
      })

      await cleanupWorktree({ jobName: 'yaac-p-s-dirs', projectSlug: 'p', worktreeId: 's-dirs' })

      expect(existedDuringDestroy).toBe(true)
      await expect(fs.access(modules)).rejects.toThrow()
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  // The dirs are mount sources, so an unconfirmed teardown keeps them: a
  // delete that never landed leaves the workspace fully alive and running
  // on them, and on the prewarm-reap path that spare stays claimable — its
  // row survives on this same verdict — so a later claim would hand a user
  // a workspace whose state dirs are gone. Both sweeps that resume the
  // teardown remove them, so keeping them only delays it.
  it('keeps the workspace dirs when the runtime could not be confirmed gone', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-keep-'))
    setDataDir(dataDir)
    try {
      const modules = worktreeModulesDir('p', 's-kept')
      const stateRoots = worktreeStateRoots('p', 's-kept')
      await fs.mkdir(modules, { recursive: true })
      for (const dir of stateRoots) await fs.mkdir(dir, { recursive: true })
      installRuntime({ destroy: () => Promise.resolve(false) })

      await expect(cleanupWorktree({
        jobName: 'yaac-p-s-kept', projectSlug: 'p', worktreeId: 's-kept',
      })).resolves.toBe(false)

      await expect(fs.access(modules)).resolves.toBeUndefined()
      for (const dir of stateRoots) {
        await expect(fs.access(dir)).resolves.toBeUndefined()
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('deleteWorktreeState', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-delete-state-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('removes everything the worktree owns on disk, and confirms it', async () => {
    const slug = 'dws'
    const wt = path.join(dataDir, 'projects', slug, 'worktrees', 'w1')
    const admin = path.join(dataDir, 'projects', slug, 'repo', '.git', 'worktrees', 'w1')
    const modules = worktreeModulesDir(slug, 'w1')
    const state = worktreeStateRoots(slug, 'w1')
    for (const dir of [wt, admin, modules, ...state]) await fs.mkdir(dir, { recursive: true })
    // Worktree setup writes this precisely so `git worktree prune` can't reap
    // a live worktree; it has to be cleared or it outlives what it protects.
    await fs.writeFile(path.join(admin, 'locked'), 'yaac\n')

    await expect(deleteWorktreeState(slug, 'w1')).resolves.toBe(true)
    // The mount sources go too. `cleanupWorktree` removes those gated on the
    // runtime being confirmed gone; every caller of THIS has already
    // established that nothing is running, which is the same establishment
    // that lets the checkout go.
    for (const dir of [wt, admin, modules, ...state]) {
      await expect(fs.access(dir)).rejects.toThrow()
    }
  })

  // Structural rather than incidental: every id that reaches this today is a
  // server-minted UUID or one read back off a row or the runtime, but an empty
  // one resolves to the worktrees ROOT — every worktree of the project.
  it('refuses an empty worktree id instead of resolving to the worktrees root', async () => {
    const slug = 'dws-empty'
    const root = path.join(dataDir, 'projects', slug, 'worktrees')
    await fs.mkdir(path.join(root, 'keeper'), { recursive: true })

    await expect(deleteWorktreeState(slug, '')).resolves.toBe(false)
    expect(await fs.readdir(root)).toEqual(['keeper'])
  })
})

describe('cleanupWorktreeDetached', () => {
  let runtime: RuntimeCalls
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-detached-'))
    setDataDir(dataDir)
    spawnMock.mockClear()
    mockServerLog.mockClear()
    clearWorktreeEvents()
    _clearTerminatingForTests()
    runtime = installRuntime()
  })

  afterEach(async () => {
    _clearTerminatingForTests()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // The script composes both halves: the runtime tears its own objects down,
  // this layer removes the dirs it owns, and the runtime's half goes first
  // because those dirs are what the workspace has mounted.
  it('composes the runtime teardown ahead of the dirs this layer owns', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-script', projectSlug: 'p', worktreeId: 's-script',
    })
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })

    const script = spawnedScript()!
    expect(script.startsWith(TEARDOWN_SENTINEL)).toBe(true)
    expect(script).toContain(`rm -rf '${worktreeModulesDir('p', 's-script')}'`)
    expect(script.indexOf(TEARDOWN_SENTINEL)).toBeLessThan(script.indexOf('rm -rf'))
  })

  // Routing has to stop in-process: a detached shell can neither drop this
  // server's port forwards nor speak to the egress registration.
  it('stops routing before it spawns anything', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-dereg', projectSlug: 'p', worktreeId: 's-dereg',
    })

    expect(runtime.deregistered).toEqual(['s-dereg'])
    expect(spawnMock).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('completes the image salvage before spawning the teardown script', async () => {
    runtime = installRuntime({ blockSalvage: true })
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-detached', projectSlug: 'p', worktreeId: 's-detached',
    })

    expect(runtime.salvaged).toEqual([
      { projectSlug: 'p', workspaceId: 's-detached', unitName: 'yaac-p-s-detached' },
    ])
    // Held open: the workspace has to outlive the salvage, which reaches
    // into it, so nothing may be spawned while it is still running.
    expect(spawnedScript()).toBeUndefined()

    runtime.releaseSalvage()
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('spawns the teardown even when the salvage fails', async () => {
    installFakeWorktreeDriver({
      salvageImages: () => Promise.reject(new Error('registry down')),
      detachedTeardownCommand: () => TEARDOWN_SENTINEL,
    })
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-salvfail', projectSlug: 'p', worktreeId: 's-salvfail',
    })
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('audits the teardown so a reaped session is never silent', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-audit', projectSlug: 'proj-a', worktreeId: 's-audit',
    })

    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('session teardown')
    expect(logged).toContain('session=s-audit')
    expect(logged).toContain('job=yaac-p-s-audit')
    expect(logged).toContain('project=proj-a')
  })

  it('marks the session terminating so the display path can render it', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-mark', projectSlug: 'proj-a', worktreeId: 's-mark',
    })
    expect(isWorktreeTerminating('s-mark')).toBe(true)
  })

  it('reports the death cause and includes it in the audit line', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'proj-a',
      worktreeId: 's-cause',
      cause: { reason: 'oom', detail: 'exit code 137' },
    })

    expect(stopsReported()).toEqual([
      ['proj-a', 's-cause', { reason: 'oom', detail: 'exit code 137' }],
    ])
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('cause=oom (exit code 137)')
  })

  it('a causeless teardown reports no cause and keeps the audit line bare', async () => {
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-nocause', projectSlug: 'proj-a', worktreeId: 's-nocause',
    })

    expect(stopsReported()).toEqual([['proj-a', 's-nocause', undefined]])
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).not.toContain('cause=')
  })

  it('preserveDeletedRecord reports no stop, leaving the recorded cause intact', async () => {
    // Resuming a teardown yaac already recorded (its terminating mark was lost)
    // must not re-report — that would clobber the real cause with a stray one.
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-resume',
      projectSlug: 'proj-a',
      worktreeId: 's-resume',
      preserveDeletedRecord: true,
    })

    expect(stopsReported()).toEqual([])
    // The teardown itself still runs (the runtime's command is idempotent,
    // so re-issuing it is exactly how a lost teardown is resumed).
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })
})

describe('worktreeModulesDir', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-sessionmodules-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('returns <dataDir>/projects/<slug>/.cached-packages/modules/<sid>', () => {
    const result = worktreeModulesDir('my-proj', 'sess-abc')
    expect(result).toBe(
      path.join(dataDir, 'projects', 'my-proj', '.cached-packages', 'modules', 'sess-abc'),
    )
  })
})

describe('gcOrphanEphemeralModuleDirs', () => {
  let dataDir: string
  /** How many pass views the sweep took — it must take at most one, ever. */
  let views: number

  /** Register the given ids as creates in flight, in the real registry the
   *  sweep reads. */
  const publishInFlight = (provisioning: string[] = []): void => {
    clearAllProvisioningForTests()
    for (const worktreeId of provisioning) {
      registerProvisioning({ worktreeId, projectSlug: 'proj-a', tool: 'claude', kind: 'create' })
    }
  }

  /** Install a runtime reporting these workspaces and stray units. */
  function seeRunning(workspaces: RuntimeHandle[], strays: StrayUnit[] = []): void {
    installFakeWorktreeDriver({
      snapshot: () => { views++; return snapshotFixture(workspaces, strays) },
    })
  }

  /** Install a runtime whose view cannot be read — the sweep must stand down. */
  function seeNothing(): void {
    installFakeWorktreeDriver({
      snapshot: () => {
        views++
        return {
          resync: true,
          workspaces: () => Promise.reject(new Error('cluster offline')),
          strayUnits: () => Promise.reject(new Error('cluster offline')),
        }
      },
    })
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
    setDataDir(dataDir)
    views = 0
    seeRunning([])
    _resetOrphanModulesSweepForTests()
    publishInFlight()
  })

  afterEach(async () => {
    clearAllProvisioningForTests()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // Backdated: what this sweep exists to collect is a leftover from a
  // previous run, and it deliberately spares anything written around its own
  // start (a create staging into it). A dir seeded microseconds before the
  // call would be the latter, not the former.
  const STALE = new Date(Date.now() - 3_600_000)

  async function seedModulesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'projects', slug, '.cached-packages', 'modules', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, STALE, STALE)
    return dir
  }

  async function seedWorktreesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'projects', slug, 'sessions', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, STALE, STALE)
    return dir
  }

  it('removes dirs whose workspace is gone and leaves live ones', async () => {
    const live = await seedModulesDir('proj-a', 'live-1')
    const deadA = await seedModulesDir('proj-a', 'dead-1')
    const deadB = await seedModulesDir('proj-b', 'dead-2')

    seeRunning([handleFixture({ workspaceId: 'live-1', projectSlug: 'proj-a' })])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(live)).resolves.toBeUndefined()
    await expect(fs.access(deadA)).rejects.toThrow()
    await expect(fs.access(deadB)).rejects.toThrow()
  })

  // A unit mid-recreate (its workspace evicted, the replacement not scheduled
  // yet) shows up ONLY as a stray, and its dirs are what the replacement is
  // about to mount.
  it('keeps dirs whose workspace survives only as a stray unit', async () => {
    const strayOnly = await seedModulesDir('proj-a', 'job-only-1')

    seeRunning([], [{
      workspaceId: 'job-only-1',
      unitName: 'yaac-proj-a-job-only-1',
      projectSlug: 'proj-a',
      createdAtMs: 0,
    }])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(strayOnly)).resolves.toBeUndefined()
  })

  it('also removes orphan per-session tmux dirs', async () => {
    const liveTmux = await seedWorktreesDir('proj-a', 'live-1')
    const deadTmux = await seedWorktreesDir('proj-a', 'dead-1')

    seeRunning([handleFixture({ workspaceId: 'live-1', projectSlug: 'proj-a' })])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(liveTmux)).resolves.toBeUndefined()
    await expect(fs.access(deadTmux)).rejects.toThrow()
  })

  it('is a no-op when the projects dir does not exist', async () => {
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('skips projects that have no modules dir', async () => {
    // Seed only the project dir, not .cached-packages/modules/.
    await fs.mkdir(path.join(dataDir, 'projects', 'proj-empty'), { recursive: true })
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('spares a session the process is still provisioning', async () => {
    // The create registers its row before it stages anything, and nothing is
    // launched yet — so no listing can vouch for it. Sweeping here deletes
    // the dirs the starting workspace is about to mount.
    const staging = await seedWorktreesDir('proj-a', 'creating-1')
    const modules = await seedModulesDir('proj-a', 'creating-1')
    publishInFlight(['creating-1'])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(staging)).resolves.toBeUndefined()
    await expect(fs.access(modules)).resolves.toBeUndefined()
  })

  // It collects what a PREVIOUS process left behind, so a second pass has
  // nothing new to find — and it runs from the reconcile loop, which would
  // otherwise re-walk the tree on every tick forever.
  it('sweeps once per server life', async () => {
    await seedWorktreesDir('proj-a', 'dead-1')

    await gcOrphanEphemeralModuleDirs()
    const taken = views
    await gcOrphanEphemeralModuleDirs()

    expect(views).toBe(taken)
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // The same race for a create with no provisioning row (a prewarmed
    // spare): freshly written is the tell, so leave it for the next sweep.
    const fresh = await seedWorktreesDir('proj-a', 'staging-1')
    await fs.utimes(fresh, new Date(), new Date())

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })

  // "I could not see" must never read as "nothing is there": the view
  // rejects rather than resolving empty, and the sweep stands down.
  it('returns quietly when the runtime view cannot be read', async () => {
    const dead = await seedModulesDir('proj-a', 'would-be-removed')
    seeNothing()

    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })
})
