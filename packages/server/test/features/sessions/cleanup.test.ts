import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type ChildProcessModule from 'node:child_process'

// Pod/Job listing is mocked (gcOrphanEphemeralModuleDirs reads it);
// sessionJobName stays real so the tmux-probe argv assertions hold.
vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
    listSessionJobs: vi.fn(),
  }
})

// The salvage execs into pods via kubectl (real subprocesses) — stub the
// module so cleanup unit tests never touch the cluster, and so the
// hooks' presence/order can be asserted.
vi.mock('#features/images/image-promoter', () => ({
  salvageSessionImages: vi.fn().mockResolvedValue(true),
}))

// The tmux probes ride the stream relay now — stub only the transport;
// the error classes stay real so classification is exercised for real.
vi.mock('#platform/k8s/stream-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof relayModule>()
  return { ...actual, sessionExec: vi.fn() }
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
vi.mock('#features/sessions/provisioning', () => ({ listProvisioning: vi.fn(() => []) }))

// The session store writes through PGlite — stub it so cleanup tests never
// open a DB, and so cause forwarding can be asserted.
vi.mock('#features/sessions/worktree-store', () => ({
  recordWorktreeStopped: vi.fn().mockResolvedValue(undefined),
}))

import { salvageSessionImages } from '#features/images/image-promoter'
import { RelayExecError, sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import { listSessionPods, listSessionJobs } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import {
  cleanupSession,
  cleanupSessionDetached,
  gcOrphanEphemeralModuleDirs,
  sessionModulesDir,
} from '#features/sessions/cleanup'
import { listProvisioning } from '#features/sessions/provisioning'
import { isSessionTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#features/status/liveness'
import { _resetSessionStatusStoreForTests } from '#features/status/status-store'
import { recordWorktreeStopped } from '#features/sessions/worktree-store'
import { serverLog } from '#log'
import { setDataDir } from '@yaac/shared/project-paths'

const sessionExecMock = vi.mocked(sessionExec)
const mockServerLog = vi.mocked(serverLog)
const mockRecordDeleted = vi.mocked(recordWorktreeStopped)

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)

function podWithSession(sessionId: string): podsModule.SessionPod {
  return {
    jobName: `yaac-proj-${sessionId}`,
    podName: `yaac-proj-${sessionId}-x1`,
    sessionId,
    projectSlug: 'proj-a',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

describe('cleanupSession', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSession).toBe('function')
  })

  it('runs the image salvage before deleting the Job', async () => {
    const mockSalvage = vi.mocked(salvageSessionImages)
    mockSalvage.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)

    await cleanupSession({
      jobName: 'yaac-p-s-promote',
      projectSlug: 'p',
      sessionId: 's-promote',
    })

    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s-promote', projectSlug: 'p', sessionId: 's-promote',
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
  // (slug, sessionId) and process-global, so a teardown that forgot to evict
  // them leaves a restarted session reading its predecessor's verdict — and
  // nothing about that failure is loud. Asserting `forgetLiveness` in
  // liveness.test.ts only proves the function works, not that cleanup calls it.
  it('evicts the liveness cache so a reused session id cannot read a stale verdict', async () => {
    _clearTmuxAliveCacheForTests()
    _resetSessionStatusStoreForTests()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)

    sessionExecMock.mockReset()
    sessionExecMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(probeTmuxLiveness('p', 's-stale')).resolves.toBe('alive')
    expect(sessionExecMock).toHaveBeenCalledTimes(1)

    // Within the TTL a second probe would be served from cache — teardown is
    // what has to invalidate it.
    await cleanupSession({ jobName: 'yaac-p-s-stale', projectSlug: 'p', sessionId: 's-stale' })

    sessionExecMock.mockRejectedValue(new RelayExecError('exit 1', 1, '', "can't find session: yaac"))
    await expect(probeTmuxLiveness('p', 's-stale')).resolves.toBe('dead')
    expect(sessionExecMock).toHaveBeenCalledTimes(2)
  })

  it('forwards the death cause to the session store', async () => {
    mockRecordDeleted.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupSession({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'p',
      sessionId: 's-cause',
      cause: { reason: 'crashed', detail: 'exit code 1' },
    })
    expect(mockRecordDeleted).toHaveBeenCalledWith(
      'p', 's-cause', { reason: 'crashed', detail: 'exit code 1' })
  })
})

describe('cleanupSessionDetached', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSessionDetached).toBe('function')
  })

  it('completes the image salvage before spawning the Job-deleting script', async () => {
    spawnMock.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    const mockSalvage = vi.mocked(salvageSessionImages)
    mockSalvage.mockClear()
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-detached',
      projectSlug: 'p',
      sessionId: 's-detached',
    })

    // The salvage → spawn chain runs after the function returns (the
    // caller must not block on a multi-minute salvage).
    await vi.waitFor(() => {
      expect(spawnMock.mock.calls.some(([cmd]) => cmd === 'sh')).toBe(true)
    })
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s-detached', projectSlug: 'p', sessionId: 's-detached',
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
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-audit',
      projectSlug: 'proj-a',
      sessionId: 's-audit',
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
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-mark',
      projectSlug: 'proj-a',
      sessionId: 's-mark',
    })
    expect(isSessionTerminating('s-mark')).toBe(true)
    _clearTerminatingForTests()
  })

  it('persists the death cause and includes it in the audit line', async () => {
    mockServerLog.mockClear()
    mockRecordDeleted.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-cause',
      projectSlug: 'proj-a',
      sessionId: 's-cause',
      cause: { reason: 'oom', detail: 'exit code 137' },
    })

    expect(mockRecordDeleted).toHaveBeenCalledWith(
      'proj-a', 's-cause', { reason: 'oom', detail: 'exit code 137' })
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('cause=oom (exit code 137)')
  })

  it('a causeless teardown records no cause and keeps the audit line bare', async () => {
    mockServerLog.mockClear()
    mockRecordDeleted.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-nocause',
      projectSlug: 'proj-a',
      sessionId: 's-nocause',
    })

    expect(mockRecordDeleted).toHaveBeenCalledWith('proj-a', 's-nocause', undefined)
    const logged = mockServerLog.mock.calls.map(([m]) => m).join('\n')
    expect(logged).not.toContain('cause=')
  })

  it('preserveDeletedRecord skips the deletion write, leaving the cause intact', async () => {
    // Resuming a teardown yaac already recorded (its terminating mark was lost)
    // must not re-record — that would clobber the real cause with a stray one.
    mockRecordDeleted.mockClear()
    execFileMock.mockReset()
    execFileMock.mockResolvedValue(undefined)
    await cleanupSessionDetached({
      jobName: 'yaac-p-s-resume',
      projectSlug: 'proj-a',
      sessionId: 's-resume',
      preserveDeletedRecord: true,
    })

    expect(mockRecordDeleted).not.toHaveBeenCalled()
    // The teardown itself still runs (idempotent Job delete resumes).
    const spawned = spawnMock.mock.calls.some(([cmd]) => cmd === 'sh')
    expect(spawned).toBe(true)
  })
})

describe('sessionModulesDir', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-sessionmodules-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('returns <dataDir>/projects/<slug>/.cached-packages/modules/<sid>', () => {
    const result = sessionModulesDir('my-proj', 'sess-abc')
    expect(result).toBe(
      path.join(dataDir, 'projects', 'my-proj', '.cached-packages', 'modules', 'sess-abc'),
    )
  })
})

describe('gcOrphanEphemeralModuleDirs', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
    setDataDir(dataDir)
    mockListPods.mockReset()
    mockListJobs.mockReset()
    mockListJobs.mockResolvedValue([])
  })

  afterEach(async () => {
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

  async function seedSessionsDir(slug: string, sid: string): Promise<string> {
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
      sessionId: 'job-only-1',
      projectSlug: 'proj-a',
      createdAtMs: 0,
    }])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(jobOnly)).resolves.toBeUndefined()
  })

  it('also removes orphan per-session tmux dirs', async () => {
    const liveTmux = await seedSessionsDir('proj-a', 'live-1')
    const deadTmux = await seedSessionsDir('proj-a', 'dead-1')

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
    const staging = await seedSessionsDir('proj-a', 'creating-1')
    const modules = await seedModulesDir('proj-a', 'creating-1')
    mockListPods.mockResolvedValue([])
    vi.mocked(listProvisioning).mockReturnValue([{
      worktreeId: 'creating-1', projectSlug: 'proj-a', tool: 'claude',
      kind: 'create', message: 'Creating session job…', createdAt: '2026-08-01 00:00:00',
    }])

    await gcOrphanEphemeralModuleDirs()

    await expect(fs.access(staging)).resolves.toBeUndefined()
    await expect(fs.access(modules)).resolves.toBeUndefined()
    vi.mocked(listProvisioning).mockReturnValue([])
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // The same race for a create with no provisioning row (a prewarmed
    // spare): freshly written is the tell, so leave it for the next sweep.
    const fresh = await seedSessionsDir('proj-a', 'staging-1')
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
