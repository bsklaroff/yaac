import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as dbModule from '#db'

vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return {
    ...actual,
    applyWorkspaceEvent: vi.fn(),
    // Real, but a test can make the project list unreadable.
    listProjectRows: vi.fn(actual.listProjectRows),
  }
})
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type ChildProcessModule from 'node:child_process'

const spawnMock = vi.fn<(cmd: string, args: string[], opts: unknown) => void>()
/** The last detached child spawned. A test emits `exit` on it to end the
 *  script, as the real child would. */
let lastChild: EventEmitter | undefined
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnMock(cmd, args, opts)
      lastChild = Object.assign(new EventEmitter(), { unref: () => { /* detached stub */ } })
      return lastChild
    },
  }
})

// Mocked so the teardown log line can be asserted.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  cleanupWorkspace,
  cleanupWorkspaceDetached,
  deleteWorkspaceState,
  gcOrphanEphemeralModuleDirs,
  teardownForRestart,
} from '#domain/workspaces/cleanup'

import { isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#runtime/status/liveness'
import { _resetWorkspaceStatusStoreForTests } from '#runtime/status/status-store'
import { serverLog } from '#log'
import {
  projectConfigDir,
  setDataDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import type { WorkspaceEvent } from '#db'
import type { NodeLocalLiveSet } from '#drivers/contract'
import { applyWorkspaceEvent, closeDb, listProjectRows, listProjectWorkspaceIds } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordProject } from '#db/project-store'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import {
  handleFixture,
  installFakeWorkspaceDriver,
  snapshotFixture,
} from '@yaac/test-utils/fake-driver'
import {
  WorkspaceExecError,
  type RuntimeHandle,
  type StrayUnit,
  type TeardownTarget,
  type WorkspaceDriver,
} from '#drivers/contract'

const mockServerLog = vi.mocked(serverLog)

// Cleanup reports the stop as an event, so applyWorkspaceEvent is stubbed
// and its events asserted. The orphan sweep's tests use real rows, since the
// sweep depends on which ids a project has.
const appliedEvents: WorkspaceEvent[] = []
vi.mocked(applyWorkspaceEvent).mockImplementation((event) => {
  appliedEvents.push(event)
  return Promise.resolve()
})
const clearWorkspaceEvents = (): void => { appliedEvents.length = 0 }
const stopsReported = (): Array<[string, string, unknown]> => appliedEvents
  .filter((e) => e.type === 'workspace-stopped')
  .map((e) => [e.projectSlug, e.workspaceId, e.cause])

/**
 * What cleanup asked the runtime to do, in order.
 *
 * The runtime's own sequencing (deregister, salvage, delete) is tested in
 * `test/drivers/k8s/workspaces/teardown.test.ts`. These tests cover the layer
 * above: what cleanup records and evicts first, what it adds around the
 * runtime's shell command, and how it handles the result.
 */
interface RuntimeCalls {
  destroyed: TeardownTarget[]
  deregistered: string[]
  salvaged: TeardownTarget[]
  /** Releases `salvageImages`, so a test can hold the chain open. */
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
  installFakeWorkspaceDriver({
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

describe('cleanupWorkspace', () => {
  let runtime: RuntimeCalls

  beforeEach(() => {
    clearWorkspaceEvents()
    runtime = installRuntime()
  })

  it('hands the runtime the workspace to destroy, and relays its verdict', async () => {
    await expect(cleanupWorkspace({
      jobName: 'yaac-p-s-casc', projectSlug: 'p', workspaceId: 's-casc',
    })).resolves.toBe(true)

    expect(runtime.destroyed).toEqual([
      { projectSlug: 'p', workspaceId: 's-casc', unitName: 'yaac-p-s-casc' },
    ])
  })

  // Callers run `deleteWorkspaceState` after this, so an unconfirmed
  // teardown must report "not gone": the workspace may still be writing.
  it('reports NOT gone when the runtime could not confirm the teardown', async () => {
    runtime = installRuntime({ destroy: () => Promise.resolve(false) })

    await expect(cleanupWorkspace({
      jobName: 'yaac-p-s-slow', projectSlug: 'p', workspaceId: 's-slow',
    })).resolves.toBe(false)
  })

  // The liveness caches are process-global and keyed by (slug, workspaceId).
  // Without eviction, a restarted session would silently read its
  // predecessor's result. liveness.test.ts cannot check that cleanup evicts.
  it('evicts the liveness cache so a reused session id cannot read a stale verdict', async () => {
    _clearTmuxAliveCacheForTests()
    _resetWorkspaceStatusStoreForTests()

    const target = { projectSlug: 'p', workspaceId: 's-stale', jobName: 'yaac-p-s-stale' }
    const exec = vi.fn<WorkspaceDriver['exec']>()
      .mockResolvedValue({ stdout: '', stderr: '' })
    installFakeWorkspaceDriver({ exec })

    await expect(probeTmuxLiveness(target)).resolves.toBe('alive')
    expect(exec).toHaveBeenCalledTimes(1)

    // Within the TTL a second probe would hit the cache; teardown must evict
    // it.
    await cleanupWorkspace({ jobName: 'yaac-p-s-stale', projectSlug: 'p', workspaceId: 's-stale' })

    exec.mockRejectedValue(new WorkspaceExecError('exit 1', 1, '', "can't find session: yaac"))
    await expect(probeTmuxLiveness(target)).resolves.toBe('dead')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reports the death cause with the stop', async () => {
    await cleanupWorkspace({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'p',
      workspaceId: 's-cause',
      cause: { reason: 'crashed', detail: 'exit code 1' },
    })
    expect(stopsReported()).toEqual([
      ['p', 's-cause', { reason: 'crashed', detail: 'exit code 1' }],
    ])
  })

  // The dirs are mount sources, so removing them first would pull them out
  // from under a container still shutting down.
  it('removes the workspace dirs only once the runtime is gone', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-order-'))
    setDataDir(dataDir)
    try {
      // A containerless workspace keeps ephemeral paths in the checkout.
      // Those are removed; the rest stays for a restart.
      const checkout = workspaceDir('p', 's-dirs')
      const modules = path.join(checkout, 'node_modules')
      await fs.mkdir(path.join(modules, 'left-pad'), { recursive: true })
      await fs.mkdir(path.join(checkout, 'src'), { recursive: true })
      let existedDuringDestroy: boolean | undefined
      installRuntime({
        destroy: async () => {
          existedDuringDestroy = await fs.access(modules).then(() => true, () => false)
          return true
        },
      })

      await cleanupWorkspace({ jobName: 'yaac-p-s-dirs', projectSlug: 'p', workspaceId: 's-dirs' })

      expect(existedDuringDestroy).toBe(true)
      await expect(fs.access(modules)).rejects.toThrow()
      await expect(fs.access(path.join(checkout, 'src'))).resolves.toBeUndefined()
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  // The agent controls the checkout, so an ephemeral path is removed only if
  // it is a real directory there. A committed `node_modules -> /anywhere`, or
  // a symlinked parent, would otherwise delete host state.
  it('leaves an ephemeral path that is, or is reached through, a symlink out of the checkout', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-link-'))
    setDataDir(dataDir)
    try {
      const outside = path.join(dataDir, 'outside')
      await fs.mkdir(path.join(outside, 'node_modules', 'kept'), { recursive: true })
      const checkout = workspaceDir('p', 's-link')
      await fs.mkdir(checkout, { recursive: true })
      await fs.symlink(path.join(outside, 'node_modules'), path.join(checkout, 'node_modules'))
      await fs.symlink(outside, path.join(checkout, 'web'))
      await fs.mkdir(projectConfigDir('p'), { recursive: true })
      await fs.writeFile(path.join(projectConfigDir('p'), 'yaac-config.json'), JSON.stringify({
        ephemeralModulesPaths: ['node_modules', 'web/node_modules'],
      }))
      installRuntime({ destroy: () => Promise.resolve(true) })

      await cleanupWorkspace({ jobName: 'yaac-p-s-link', projectSlug: 'p', workspaceId: 's-link' })

      await expect(fs.access(path.join(outside, 'node_modules', 'kept'))).resolves.toBeUndefined()
      expect((await fs.lstat(path.join(checkout, 'node_modules'))).isSymbolicLink()).toBe(true)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  // If the delete never landed, the workspace is still running on these
  // dirs, and a reaped spare stays claimable. The sweeps that resume the
  // teardown remove them later.
  it('keeps the workspace dirs when the runtime could not be confirmed gone', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-keep-'))
    setDataDir(dataDir)
    try {
      const stateDir = workspaceStateDir('p', 's-kept')
      const checkoutModules = path.join(workspaceDir('p', 's-kept'), 'node_modules')
      await fs.mkdir(checkoutModules, { recursive: true })
      await fs.mkdir(stateDir, { recursive: true })
      installRuntime({ destroy: () => Promise.resolve(false) })

      await expect(cleanupWorkspace({
        jobName: 'yaac-p-s-kept', projectSlug: 'p', workspaceId: 's-kept',
      })).resolves.toBe(false)

      await expect(fs.access(checkoutModules)).resolves.toBeUndefined()
      await expect(fs.access(stateDir)).resolves.toBeUndefined()
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('deleteWorkspaceState', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-delete-state-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('removes the checkout, its git admin dir and its log, and confirms it', async () => {
    const slug = 'dws'
    const wt = path.join(dataDir, 'global', 'projects', slug, 'workspaces', 'w1')
    const admin = path.join(dataDir, 'global', 'projects', slug, 'repo', '.git', 'worktrees', 'w1')
    await fs.mkdir(wt, { recursive: true })
    await fs.mkdir(admin, { recursive: true })
    // Setup writes this so `git worktree prune` cannot reap a live workspace;
    // teardown must clear it.
    await fs.writeFile(path.join(admin, 'locked'), 'yaac\n')

    await expect(deleteWorkspaceState(slug, 'w1')).resolves.toBe(true)
    await expect(fs.access(wt)).rejects.toThrow()
    await expect(fs.access(admin)).rejects.toThrow()
  })

  // Ids are server-minted today, but an empty id would resolve to the
  // workspaces root, i.e. every workspace of the project.
  it('refuses an empty workspace id instead of resolving to the workspaces root', async () => {
    const slug = 'dws-empty'
    const root = path.join(dataDir, 'global', 'projects', slug, 'workspaces')
    await fs.mkdir(path.join(root, 'keeper'), { recursive: true })

    await expect(deleteWorkspaceState(slug, '')).resolves.toBe(false)
    expect(await fs.readdir(root)).toEqual(['keeper'])
  })
})

describe('cleanupWorkspaceDetached', () => {
  let runtime: RuntimeCalls
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cleanup-detached-'))
    setDataDir(dataDir)
    spawnMock.mockClear()
    mockServerLog.mockClear()
    clearWorkspaceEvents()
    _clearTerminatingForTests()
    runtime = installRuntime()
  })

  afterEach(async () => {
    _clearTerminatingForTests()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // The runtime's teardown runs before this layer removes its dirs, since
  // the workspace has those dirs mounted.
  it('composes the runtime teardown ahead of the dirs this layer owns', async () => {
    const checkoutModules = path.join(workspaceDir('p', 's-script'), 'node_modules')
    await fs.mkdir(checkoutModules, { recursive: true })
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-script', projectSlug: 'p', workspaceId: 's-script',
    })
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })

    const script = spawnedScript()!
    expect(script.startsWith(TEARDOWN_SENTINEL)).toBe(true)
    expect(script).toContain(`rm -rf '${checkoutModules}'`)
    expect(script.indexOf(TEARDOWN_SENTINEL)).toBeLessThan(script.indexOf('rm -rf'))
  })

  // Routing must stop in-process: a detached shell cannot drop this server's
  // port forwards or egress registration.
  it('stops routing before it spawns anything', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-dereg', projectSlug: 'p', workspaceId: 's-dereg',
    })

    expect(runtime.deregistered).toEqual(['s-dereg'])
    expect(spawnMock).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('completes the image salvage before spawning the teardown script', async () => {
    runtime = installRuntime({ blockSalvage: true })
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-detached', projectSlug: 'p', workspaceId: 's-detached',
    })

    expect(runtime.salvaged).toEqual([
      { projectSlug: 'p', workspaceId: 's-detached', unitName: 'yaac-p-s-detached' },
    ])
    // The salvage reads from the workspace, so nothing is spawned until it
    // finishes.
    expect(spawnedScript()).toBeUndefined()

    runtime.releaseSalvage()
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('spawns the teardown even when the salvage fails', async () => {
    installFakeWorkspaceDriver({
      salvageImages: () => Promise.reject(new Error('registry down')),
      detachedTeardownCommand: () => TEARDOWN_SENTINEL,
    })
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-salvfail', projectSlug: 'p', workspaceId: 's-salvfail',
    })
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })

  it('audits the teardown so a reaped session is never silent', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-audit', projectSlug: 'proj-a', workspaceId: 's-audit',
    })

    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('session teardown')
    expect(logged).toContain('session=s-audit')
    expect(logged).toContain('job=yaac-p-s-audit')
    expect(logged).toContain('project=proj-a')
  })

  it('marks the session terminating so the display path can render it', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-mark', projectSlug: 'proj-a', workspaceId: 's-mark',
    })
    expect(isWorkspaceTerminating('s-mark')).toBe(true)
  })

  it('reports the death cause and includes it in the audit line', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'proj-a',
      workspaceId: 's-cause',
      cause: { reason: 'oom', detail: 'exit code 137' },
    })

    expect(stopsReported()).toEqual([
      ['proj-a', 's-cause', { reason: 'oom', detail: 'exit code 137' }],
    ])
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('cause=oom (exit code 137)')
  })

  it('a causeless teardown reports no cause and keeps the audit line bare', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-nocause', projectSlug: 'proj-a', workspaceId: 's-nocause',
    })

    expect(stopsReported()).toEqual([['proj-a', 's-nocause', undefined]])
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).not.toContain('cause=')
  })

  it('preserveDeletedRecord reports no stop, leaving the recorded cause intact', async () => {
    // Resuming a recorded teardown (whose terminating mark was lost) must not
    // re-report, which would overwrite the real cause.
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-resume',
      projectSlug: 'proj-a',
      workspaceId: 's-resume',
      preserveDeletedRecord: true,
    })

    expect(stopsReported()).toEqual([])
    // The idempotent teardown still runs; that is how it is resumed.
    await vi.waitFor(() => { expect(spawnedScript()).toBeDefined() })
  })
})

describe('teardownForRestart', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-restart-teardown-'))
    setDataDir(dataDir)
    spawnMock.mockClear()
    clearWorkspaceEvents()
    _clearTerminatingForTests()
    installRuntime()
  })

  afterEach(async () => {
    _clearTerminatingForTests()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // A stop returns while its detached script still runs, and under
  // containerless the runtime has already forgotten the workspace. A quick
  // restart would relaunch into a checkout the script is still cleaning.
  it('waits for the workspace\'s detached teardown to exit before a relaunch', async () => {
    await cleanupWorkspaceDetached({
      jobName: 'yaac-p-s-race', projectSlug: 'p', workspaceId: 's-race',
    })
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })

    let settled = false
    const restart = teardownForRestart({ jobName: null, projectSlug: 'p', workspaceId: 's-race' })
      .then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    lastChild!.emit('exit', 0)
    await restart
    expect(settled).toBe(true)
    // The stop's terminating mark is cleared, so the new workspace does not
    // show as stopping.
    expect(isWorkspaceTerminating('s-race')).toBe(false)
  })

  it('returns at once for a workspace with no teardown in flight', async () => {
    await teardownForRestart({ jobName: null, projectSlug: 'p', workspaceId: 's-idle' })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('gcOrphanEphemeralModuleDirs', () => {
  let dataDir: string

  /** Register ids as in-flight creates in the real registry. */
  const publishInFlight = (provisioning: string[] = []): void => {
    clearAllProvisioningForTests()
    for (const workspaceId of provisioning) {
      registerProvisioning({ workspaceId, projectSlug: 'proj-a', tool: 'claude', kind: 'create' })
    }
  }

  /** Live sets passed to the runtime's node-local reap. */
  let reaped: NodeLocalLiveSet[]

  /** Install a runtime reporting these workspaces and stray units. */
  function seeRunning(workspaces: RuntimeHandle[], strays: StrayUnit[] = []): void {
    installFakeWorkspaceDriver({
      snapshot: () => snapshotFixture(workspaces, strays),
      reapNodeLocal: (live) => { reaped.push(live); return Promise.resolve() },
    })
  }

  /** Install a runtime whose view cannot be read. */
  function seeNothing(): void {
    installFakeWorkspaceDriver({
      snapshot: () => {
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
    reaped = []
    seeRunning([])
    publishInFlight()
  })

  afterEach(async () => {
    clearAllProvisioningForTests()
    await closeDb()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // Backdated, since the sweep spares anything written around its own start
  // (a create staging into it).
  const STALE = new Date(Date.now() - 3_600_000)

  async function seedModulesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'node-local', 'projects', slug, '.cached-packages', 'modules', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, STALE, STALE)
    return dir
  }

  async function seedWorkspacesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'global', 'projects', slug, 'sessions', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, STALE, STALE)
    return dir
  }

  // Node-local dirs may live on another node, so the runtime removes them.
  // This layer only hands over the live set: recorded project ids,
  // workspaces, stray units and in-flight creates.
  it('hands the runtime the live project ids and workspaces, and removes no node-local dir itself', async () => {
    await recordProject({ slug: 'proj-a', remoteUrl: 'https://x/proj-a', addedAt: '2026-01-01' })
    await recordProject({ slug: 'proj-b', remoteUrl: 'https://x/proj-b', addedAt: '2026-01-01' })
    const ids = (await listProjectRows()).map((r) => r.id)
    const live = await seedModulesDir(ids[0], 'live-1')
    const dead = await seedModulesDir(ids[0], 'dead-1')
    const strayOnly = await seedModulesDir(ids[1], 'job-only-1')
    const orphan = await seedModulesDir('removed-project', 'x')
    publishInFlight(['creating-1'])

    seeRunning(
      [handleFixture({ workspaceId: 'live-1', projectSlug: 'proj-a' })],
      // A unit mid-recreate appears only as a stray, and its replacement is
      // about to mount its dirs.
      [{ workspaceId: 'job-only-1', unitName: 'yaac-proj-b-job-only-1', projectSlug: 'proj-b', createdAtMs: 0 }],
    )

    await gcOrphanEphemeralModuleDirs()

    expect(reaped).toEqual([{
      projectIds: new Set(ids),
      workspaceIds: new Set(['live-1', 'job-only-1', 'creating-1']),
    }])
    for (const dir of [live, dead, strayOnly, orphan]) {
      await expect(fs.access(dir)).resolves.toBeUndefined()
    }
  })

  // An empty list would make every project's tree look orphaned, so an
  // unreadable list skips the node-local reap.
  it('hands the runtime nothing when the projects cannot be listed', async () => {
    vi.mocked(listProjectRows).mockRejectedValueOnce(new Error('db closed'))
    const dead = await seedWorkspacesDir('proj-a', 'dead-1')

    await gcOrphanEphemeralModuleDirs()

    expect(reaped).toHaveLength(0)
    // The global sweep does not depend on the list and still runs.
    await expect(fs.access(dead)).rejects.toThrow()
  })

  it('also removes orphan per-session tmux dirs', async () => {
    const liveTmux = await seedWorkspacesDir('proj-a', 'live-1')
    const deadTmux = await seedWorkspacesDir('proj-a', 'dead-1')

    seeRunning([handleFixture({ workspaceId: 'live-1', projectSlug: 'proj-a' })])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(liveTmux)).resolves.toBeUndefined()
    await expect(fs.access(deadTmux)).rejects.toThrow()
  })

  // Only a dead spare's checkout is disposable; a stopped workspace's is
  // kept.
  it('collects a dead spare, and keeps a stopped workspace', async () => {
    await recordWorkspaceCreated({ projectSlug: 'proj-a', workspaceId: 'stopped-1' })
    await recordWorkspaceCreated({ projectSlug: 'proj-a', workspaceId: 'spare-1', spare: true })
    // Both checkouts are stale, so only the spare flag tells them apart.
    const [spareCheckout, stoppedCheckout] = await Promise.all(['spare-1', 'stopped-1'].map(async (sid) => {
      const dir = workspaceDir('proj-a', sid)
      await fs.mkdir(dir, { recursive: true })
      await fs.utimes(dir, STALE, STALE)
      return dir
    }))
    seeRunning([handleFixture({ workspaceId: 'live-1', projectSlug: 'proj-a' })])

    try {
      await gcOrphanEphemeralModuleDirs()

      await expect(fs.access(stoppedCheckout)).resolves.toBeUndefined()
      await expect(fs.access(spareCheckout)).rejects.toThrow()
      expect([...(await listProjectWorkspaceIds('proj-a')).keys()]).toEqual(['stopped-1'])
    } finally {
      await closeDb()
    }
  })

  // No project is live, so every node-local tree is an orphan.
  it('with no projects, hands the runtime an empty live set', async () => {
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    expect(reaped).toEqual([{ projectIds: new Set(), workspaceIds: new Set() }])
  })

  it('spares a session the process is still provisioning', async () => {
    // The create records its row before anything is launched, so no
    // listing shows it yet; sweeping would delete dirs it is about to mount.
    const staging = await seedWorkspacesDir('proj-a', 'creating-1')
    publishInFlight(['creating-1'])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(staging)).resolves.toBeUndefined()
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // The same race for a create with no provisioning row (a spare): a
    // fresh dir is left for the next sweep.
    const fresh = await seedWorkspacesDir('proj-a', 'staging-1')
    await fs.utimes(fresh, new Date(), new Date())

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })

  // An unreadable view must not read as empty: the sweep does nothing, and
  // the runtime gets no live set to reap against.
  it('returns quietly when the runtime view cannot be read', async () => {
    const dead = await seedWorkspacesDir('proj-a', 'would-be-removed')
    seeNothing()

    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    await expect(fs.access(dead)).resolves.toBeUndefined()
    expect(reaped).toHaveLength(0)
  })
})
