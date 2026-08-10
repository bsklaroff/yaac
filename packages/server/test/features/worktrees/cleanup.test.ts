import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type ChildProcessModule from 'node:child_process'

// Pod/Job listing is mocked (gcOrphanEphemeralModuleDirs reads it);
// worktreeJobName stays real so the tmux-probe argv assertions hold.
vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorktreePods: vi.fn(),
    listWorktreeJobs: vi.fn(),
  }
})

// The salvage execs into pods via kubectl (real subprocesses) — stub the
// module so cleanup unit tests never touch the cluster, and so the
// hooks' presence/order can be asserted.
vi.mock('#features/images/image-promoter', () => ({
  salvageWorktreeImages: vi.fn().mockResolvedValue(true),
}))

// The tmux probes ride the stream relay now — stub only the transport;
// the error classes stay real so classification is exercised for real.
vi.mock('#platform/k8s/stream-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof relayModule>()
  return { ...actual, podExec: vi.fn() }
})

const execFileMock = vi.fn<(cmd: string, args: string[], opts: unknown) => Promise<void | { stdout: string }>>()
const spawnMock = vi.fn<(cmd: string, args: string[], opts: unknown) => void>()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
  // Real execFile carries util.promisify.custom so promisify(execFile)
  // resolves `{ stdout, stderr }` — mirror that, or code destructuring
  // stdout would silently get a bare string under test.
  const execFile = Object.assign(
    (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      // promisify-less callers invoke the 4-arg form with opts.
      execFileMock(cmd, args, opts).then(
        (res) => { cb(null, res && typeof res === 'object' ? res.stdout : '', '') },
        (err: Error) => { cb(err, '', '') },
      )
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (cmd: string, args: string[], opts: unknown) =>
        execFileMock(cmd, args, opts).then(
          (res) => ({ stdout: res && typeof res === 'object' ? res.stdout : '', stderr: '' }),
        ),
    },
  )
  return {
    ...actual,
    execFile,
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnMock(cmd, args, opts)
      return { unref: () => { /* detached stub */ } }
    },
  }
})

// Audit logging is a vi.fn so the teardown line can be asserted without a
// real server.log on disk.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { salvageWorktreeImages } from '#features/images/image-promoter'
import { RelayExecError, podExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import { listWorktreePods, listWorktreeJobs } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import {
  _resetOrphanModulesSweepForTests,
  cleanupWorktree,
  cleanupWorktreeDetached,
  gcOrphanEphemeralModuleDirs,
  worktreeModulesDir,
} from '#features/worktrees/cleanup'
import {
  _resetDesiredWorkspacesForTests,
  publishDesiredWorkspaces,
} from '#herd-desired'
import { isWorktreeTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#features/status/liveness'
import { _resetWorktreeStatusStoreForTests } from '#features/status/status-store'
import { _setServerLinkForTests } from '#server-link'
import { serverLog } from '#log'
import { setDataDir } from '@yaac/shared/project-paths'
import type { HerdEvent } from '@yaac/shared/herd'

const podExecMock = vi.mocked(podExec)
const mockServerLog = vi.mocked(serverLog)

// Cleanup reports the stop rather than writing the row itself, so a stub
// link stands in for the server: these tests never open a DB, and what the
// herd half says about a teardown is asserted directly.
const herdEvents: HerdEvent[] = []
_setServerLinkForTests({
  workspaceEvent: (event) => {
    herdEvents.push(event)
    return Promise.resolve()
  },
})
const clearHerdEvents = (): void => { herdEvents.length = 0 }
const stopsReported = (): Array<[string, string, unknown]> => herdEvents
  .filter((e) => e.type === 'worktree-stopped')
  .map((e) => [e.projectSlug, e.worktreeId, e.cause])

const mockListPods = vi.mocked(listWorktreePods)
const mockListJobs = vi.mocked(listWorktreeJobs)

function podWithSession(worktreeId: string): podsModule.PodInfo {
  return {
    jobName: `yaac-proj-${worktreeId}`,
    podName: `yaac-proj-${worktreeId}-x1`,
    worktreeId,
    projectSlug: 'proj-a',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

describe('cleanupWorktree', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupWorktree).toBe('function')
  })

  it('runs the image salvage before deleting the Job', async () => {
    const mockSalvage = vi.mocked(salvageWorktreeImages)
    mockSalvage.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)

    await cleanupWorktree({
      jobName: 'yaac-p-s-promote',
      projectSlug: 'p',
      worktreeId: 's-promote',
    })

    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s-promote', projectSlug: 'p', worktreeId: 's-promote',
    })
    // The pod (and its graphroot tmpfs) must still exist when the
    // salvage runs — the Job delete has to come after.
    const deleteCall = execFileMock.mock.calls.find(
      ([cmd, args]) => cmd === 'kubectl' && args[0] === 'delete' && args.includes('yaac-p-s-promote'),
    )
    expect(deleteCall).toBeDefined()
    const salvageOrder = mockSalvage.mock.invocationCallOrder[0]
    const deleteOrder = execFileMock.mock.invocationCallOrder[
      execFileMock.mock.calls.indexOf(deleteCall!)
    ]
    expect(salvageOrder).toBeLessThan(deleteOrder)
  })

  // Reaches across the seal on purpose. The liveness caches are keyed by
  // (slug, worktreeId) and process-global, so a teardown that forgot to evict
  // them leaves a restarted session reading its predecessor's verdict — and
  // nothing about that failure is loud. Asserting `forgetLiveness` in
  // liveness.test.ts only proves the function works, not that cleanup calls it.
  it('evicts the liveness cache so a reused session id cannot read a stale verdict', async () => {
    _clearTmuxAliveCacheForTests()
    _resetWorktreeStatusStoreForTests()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)

    podExecMock.mockReset()
    podExecMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(probeTmuxLiveness('p', 's-stale')).resolves.toBe('alive')
    expect(podExecMock).toHaveBeenCalledTimes(1)

    // Within the TTL a second probe would be served from cache — teardown is
    // what has to invalidate it.
    await cleanupWorktree({ jobName: 'yaac-p-s-stale', projectSlug: 'p', worktreeId: 's-stale' })

    podExecMock.mockRejectedValue(new RelayExecError('exit 1', 1, '', "can't find session: yaac"))
    await expect(probeTmuxLiveness('p', 's-stale')).resolves.toBe('dead')
    expect(podExecMock).toHaveBeenCalledTimes(2)
  })

  it('reports the death cause with the stop', async () => {
    clearHerdEvents()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
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
})

describe('cleanupWorktreeDetached', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupWorktreeDetached).toBe('function')
  })

  it('completes the image salvage before spawning the Job-deleting script', async () => {
    spawnMock.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    const mockSalvage = vi.mocked(salvageWorktreeImages)
    mockSalvage.mockClear()
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-detached',
      projectSlug: 'p',
      worktreeId: 's-detached',
    })

    // The salvage → spawn chain runs after the function returns (the
    // caller must not block on a multi-minute salvage).
    await vi.waitFor(() => {
      expect(spawnMock.mock.calls.some(([cmd]) => cmd === 'sh')).toBe(true)
    })
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s-detached', projectSlug: 'p', worktreeId: 's-detached',
    })
    const call = spawnMock.mock.calls.find(([cmd]) => cmd === 'sh')!
    const script = (call[1])[1]
    // The pod must outlive the salvage: the delete is only ever spawned
    // after the salvage settles.
    expect(mockSalvage.mock.invocationCallOrder[0])
      .toBeLessThan(spawnMock.mock.invocationCallOrder[0])
    expect(script).toContain('kubectl delete job yaac-p-s-detached')
  })

  it('audits the teardown so a reaped session is never silent', async () => {
    spawnMock.mockClear()
    mockServerLog.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-audit',
      projectSlug: 'proj-a',
      worktreeId: 's-audit',
    })

    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('session teardown')
    expect(logged).toContain('session=s-audit')
    expect(logged).toContain('job=yaac-p-s-audit')
    expect(logged).toContain('project=proj-a')
  })

  it('marks the session terminating so the display path can render it', async () => {
    _clearTerminatingForTests()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-mark',
      projectSlug: 'proj-a',
      worktreeId: 's-mark',
    })
    expect(isWorktreeTerminating('s-mark')).toBe(true)
    _clearTerminatingForTests()
  })

  it('reports the death cause and includes it in the audit line', async () => {
    mockServerLog.mockClear()
    clearHerdEvents()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
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
    mockServerLog.mockClear()
    clearHerdEvents()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-nocause',
      projectSlug: 'proj-a',
      worktreeId: 's-nocause',
    })

    expect(stopsReported()).toEqual([['proj-a', 's-nocause', undefined]])
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).not.toContain('cause=')
  })

  it('preserveDeletedRecord reports no stop, leaving the recorded cause intact', async () => {
    // Resuming a teardown yaac already recorded (its terminating mark was lost)
    // must not re-report — that would clobber the real cause with a stray one.
    clearHerdEvents()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupWorktreeDetached({
      jobName: 'yaac-p-s-resume',
      projectSlug: 'proj-a',
      worktreeId: 's-resume',
      preserveDeletedRecord: true,
    })

    expect(stopsReported()).toEqual([])
    // The teardown itself still runs (idempotent Job delete resumes).
    const spawned = spawnMock.mock.calls.some(([cmd]) => cmd === 'sh')
    expect(spawned).toBe(true)
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

  /** Publish a desired set with the given in-flight ids. The sweep stands
   *  down until the server has published one, so every case that expects it
   *  to act publishes first. */
  const publishInFlight = (provisioning: string[] = []): void =>
    publishDesiredWorkspaces({ live: [], stopped: [], provisioning })

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
    setDataDir(dataDir)
    mockListPods.mockReset()
    mockListJobs.mockReset()
    mockListJobs.mockResolvedValue([])
    _resetOrphanModulesSweepForTests()
    _resetDesiredWorkspacesForTests()
    publishInFlight()
  })

  afterEach(async () => {
    _resetDesiredWorkspacesForTests()
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

  it('removes dirs whose session pod is gone and leaves live ones', async () => {
    const live = await seedModulesDir('proj-a', 'live-1')
    const deadA = await seedModulesDir('proj-a', 'dead-1')
    const deadB = await seedModulesDir('proj-b', 'dead-2')

    mockListPods.mockResolvedValue([podWithSession('live-1')])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(live)).resolves.toBeUndefined()
    await expect(fs.access(deadA)).rejects.toThrow()
    await expect(fs.access(deadB)).rejects.toThrow()
  })

  it('keeps dirs whose session only shows up in the Job list (pod mid-recreate)', async () => {
    const jobOnly = await seedModulesDir('proj-a', 'job-only-1')

    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([{
      jobName: 'yaac-proj-a-job-only-1',
      worktreeId: 'job-only-1',
      projectSlug: 'proj-a',
      createdAtMs: 0,
    }])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(jobOnly)).resolves.toBeUndefined()
  })

  it('also removes orphan per-session tmux dirs', async () => {
    const liveTmux = await seedWorktreesDir('proj-a', 'live-1')
    const deadTmux = await seedWorktreesDir('proj-a', 'dead-1')

    mockListPods.mockResolvedValue([podWithSession('live-1')])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(liveTmux)).resolves.toBeUndefined()
    await expect(fs.access(deadTmux)).rejects.toThrow()
  })

  it('is a no-op when the projects dir does not exist', async () => {
    // No projects dir seeded at all.
    mockListPods.mockResolvedValue([])
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('skips projects that have no modules dir', async () => {
    // Seed only the project dir, not .cached-packages/modules/.
    await fs.mkdir(path.join(dataDir, 'projects', 'proj-empty'), { recursive: true })
    mockListPods.mockResolvedValue([])
    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
  })

  it('spares a session the process is still provisioning', async () => {
    // The create registers its row before it stages anything, and its Job is
    // not applied yet — so no pod/Job listing can vouch for it. Sweeping here
    // deletes the dirs the starting pod is about to mount.
    const staging = await seedWorktreesDir('proj-a', 'creating-1')
    const modules = await seedModulesDir('proj-a', 'creating-1')
    mockListPods.mockResolvedValue([])
    // Delivered with the desired set — the sweep never reads the server's
    // provisioning registry.
    publishInFlight(['creating-1'])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(staging)).resolves.toBeUndefined()
    await expect(fs.access(modules)).resolves.toBeUndefined()
  })

  // The in-flight set is the only thing standing between this sweep and a
  // create's staged dirs, so with no set published it must not run at all —
  // it runs on the next pass, once the server has said what exists.
  it('stands down entirely until the server has published a set', async () => {
    const dead = await seedWorktreesDir('proj-a', 'dead-1')
    _resetDesiredWorkspacesForTests()
    mockListPods.mockResolvedValue([])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(dead)).resolves.toBeUndefined()
  })

  // It collects what a PREVIOUS process left behind, so a second pass has
  // nothing new to find — and it runs from the reconcile loop, which would
  // otherwise re-walk the tree on every tick forever.
  it('sweeps once per herd life', async () => {
    await seedWorktreesDir('proj-a', 'dead-1')
    mockListPods.mockResolvedValue([])

    await gcOrphanEphemeralModuleDirs()
    const listings = mockListPods.mock.calls.length
    await gcOrphanEphemeralModuleDirs()

    expect(mockListPods.mock.calls.length).toBe(listings)
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // The same race for a create with no provisioning row (a prewarmed
    // spare): freshly written is the tell, so leave it for the next sweep.
    const fresh = await seedWorktreesDir('proj-a', 'staging-1')
    await fs.utimes(fresh, new Date(), new Date())
    mockListPods.mockResolvedValue([])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })

  it('returns quietly if pod listing fails', async () => {
    const dead = await seedModulesDir('proj-a', 'would-be-removed')
    mockListPods.mockRejectedValue(new Error('cluster offline'))

    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    // Nothing was removed because we bailed out before the sweep.
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })
})
