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

// The deleted-store writes through PGlite — stub it so cleanup tests never
// open a DB, and so cause forwarding can be asserted.
vi.mock('#features/sessions/deleted-store', () => ({
  recordSessionDeleted: vi.fn().mockResolvedValue(undefined),
}))

import { salvageSessionImages } from '#features/images/image-promoter'
import { RelayDialError, RelayExecError, sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import { listSessionPods, listSessionJobs } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import {
  isTmuxSessionAlive,
  probeTmuxLiveness,
  probeAgentPaneState,
  classifyTmuxProbeError,
  cleanupSession,
  cleanupSessionDetached,
  sessionModulesDir,
  gcOrphanEphemeralModuleDirs,
  _clearTmuxAliveCacheForTests,
  _clearAgentStartedCacheForTests,
} from '#features/sessions/cleanup'
import { isSessionTerminating, _clearTerminatingForTests } from '#features/sessions/state'
import { setSessionStreamHealth, _resetSessionStatusStoreForTests } from '#features/sessions/status-store'
import { recordSessionDeleted } from '#features/sessions/deleted-store'
import { serverLog } from '#log'
import { setDataDir } from '@yaac/shared/project-paths'

const mockServerLog = vi.mocked(serverLog)
const mockRecordDeleted = vi.mocked(recordSessionDeleted)

const sessionExecMock = vi.mocked(sessionExec)
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

describe('isTmuxSessionAlive', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execFileMock.mockReset()
    sessionExecMock.mockReset()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxalive-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setProbeResult(slug: string, sid: string, alive: boolean): void {
    const job = `yaac-${slug}-${sid}`
    sessionExecMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('has-session')) {
        return alive
          ? Promise.resolve({ stdout: '', stderr: '' })
          : Promise.reject(new RelayExecError('exit 1', 1, '', "can't find session: yaac"))
      }
      return Promise.reject(new RelayDialError('unexpected sessionExec call'))
    })
  }

  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
  })

  it('returns true when has-session exits 0', async () => {
    setProbeResult('p', 's-up', true)
    await expect(isTmuxSessionAlive('p', 's-up')).resolves.toBe(true)
    expect(sessionExecMock).toHaveBeenCalledWith(
      'yaac-p-s-up',
      'tmux -S /tmp/yaac-tmux/server has-session -t yaac',
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    )
  })

  it('returns false when has-session exits non-zero', async () => {
    setProbeResult('p', 's-absent', false)
    await expect(isTmuxSessionAlive('p', 's-absent')).resolves.toBe(false)
  })

  it('serves repeat calls from the TTL cache without re-probing', async () => {
    setProbeResult('p', 's-cache', true)
    expect(await isTmuxSessionAlive('p', 's-cache')).toBe(true)
    // Flip the probe result — the cache should still return the old value within TTL.
    setProbeResult('p', 's-cache', false)
    expect(await isTmuxSessionAlive('p', 's-cache')).toBe(true)
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    setProbeResult('p', 's-coalesce', true)
    const p1 = isTmuxSessionAlive('p', 's-coalesce')
    const p2 = isTmuxSessionAlive('p', 's-coalesce')
    const p3 = isTmuxSessionAlive('p', 's-coalesce')
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true])
    expect(sessionExecMock).toHaveBeenCalledTimes(1)
  })

  it('caches per (slug, sid), not globally', async () => {
    sessionExecMock.mockImplementation((jobName) => {
      return jobName === 'yaac-p-s-a'
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new RelayExecError('exit 1', 1, '', 'no session'))
    })
    expect(await isTmuxSessionAlive('p', 's-a')).toBe(true)
    expect(await isTmuxSessionAlive('p', 's-b')).toBe(false)
  })

  it('cleanupSession evicts the cache entry for that session', async () => {
    setProbeResult('p', 's-evict', true)
    expect(await isTmuxSessionAlive('p', 's-evict')).toBe(true)

    // cleanupSession's `kubectl delete job` and proxy lookups also hit the
    // mocked execFile and reject ("unexpected execFile call") — both paths
    // are best-effort and swallow the error.
    await cleanupSession({
      jobName: 'yaac-p-s-evict',
      projectSlug: 'p',
      sessionId: 's-evict',
    })

    // Cache is gone — flip the probe and observe that the next call re-runs.
    setProbeResult('p', 's-evict', false)
    expect(await isTmuxSessionAlive('p', 's-evict')).toBe(false)
  })
})

describe('probeAgentPaneState', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearAgentStartedCacheForTests()
    execFileMock.mockReset()
    sessionExecMock.mockReset()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agentpane-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setPaneCommand(slug: string, sid: string, command: string | Error): void {
    const job = `yaac-${slug}-${sid}`
    sessionExecMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('display-message')) {
        return command instanceof Error
          ? Promise.reject(command)
          : Promise.resolve({ stdout: `${command}\n`, stderr: '' })
      }
      return Promise.reject(new RelayDialError('unexpected sessionExec call'))
    })
  }

  it('reports the sleep keepalive as placeholder, targeting the first window', async () => {
    setPaneCommand('p', 's-half', 'sleep')
    await expect(probeAgentPaneState('p', 's-half')).resolves.toBe('placeholder')
    expect(sessionExecMock).toHaveBeenCalledWith(
      'yaac-p-s-half',
      "tmux -S /tmp/yaac-tmux/server display-message -p -t 'yaac:^' '#{pane_current_command}'",
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    )
  })

  it('reports any other pane command as started', async () => {
    setPaneCommand('p', 's-live', 'claude')
    await expect(probeAgentPaneState('p', 's-live')).resolves.toBe('started')
  })

  it('memoizes a started verdict and never re-probes it', async () => {
    setPaneCommand('p', 's-memo', 'claude')
    await expect(probeAgentPaneState('p', 's-memo')).resolves.toBe('started')
    // Even a later sleep-looking probe result can't demote it (respawn -k
    // killed the placeholder; started is terminal) — and no exec runs.
    setPaneCommand('p', 's-memo', 'sleep')
    await expect(probeAgentPaneState('p', 's-memo')).resolves.toBe('started')
    expect(sessionExecMock).toHaveBeenCalledTimes(1)
  })

  it('reports unknown on a probe failure, and keeps re-probing', async () => {
    setPaneCommand('p', 's-blip', new Error('exec timed out'))
    await expect(probeAgentPaneState('p', 's-blip')).resolves.toBe('unknown')
    setPaneCommand('p', 's-blip', 'sleep')
    await expect(probeAgentPaneState('p', 's-blip')).resolves.toBe('placeholder')
  })

  it('cleanupSession evicts the memoized verdict for that session', async () => {
    setPaneCommand('p', 's-evict2', 'claude')
    await expect(probeAgentPaneState('p', 's-evict2')).resolves.toBe('started')

    await cleanupSession({
      jobName: 'yaac-p-s-evict2',
      projectSlug: 'p',
      sessionId: 's-evict2',
    })

    setPaneCommand('p', 's-evict2', 'sleep')
    await expect(probeAgentPaneState('p', 's-evict2')).resolves.toBe('placeholder')
  })
})

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

  it('forwards the death cause to the deleted-store', async () => {
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

  it('preserveDeletedRecord skips the deleted-store write, leaving the cause intact', async () => {
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

describe('classifyTmuxProbeError', () => {
  it('is dead only when the probe reached the pod and tmux exited non-zero', () => {
    // streamd ran tmux and it reported the session absent — conclusive.
    expect(classifyTmuxProbeError(
      new RelayExecError('exit 1', 1, '', "can't find session: yaac"),
    )).toBe('dead')
  })

  it('is unknown on transport failures — never a reap signal', () => {
    expect(classifyTmuxProbeError(new RelayDialError('relay refused'))).toBe('unknown')
    expect(classifyTmuxProbeError(new RelayDialError('stream read timeout after 2000ms'))).toBe('unknown')
  })

  it('is unknown when there is no usable error detail', () => {
    expect(classifyTmuxProbeError(new Error('boom'))).toBe('unknown')
    expect(classifyTmuxProbeError(undefined)).toBe('unknown')
    expect(classifyTmuxProbeError(null)).toBe('unknown')
  })
})

describe('probeTmuxLiveness', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execFileMock.mockReset()
    sessionExecMock.mockReset()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxprobe-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('is alive when has-session exits 0', async () => {
    sessionExecMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(probeTmuxLiveness('p', 's-alive')).resolves.toBe('alive')
  })

  it('is dead when the remote tmux exits non-zero', async () => {
    sessionExecMock.mockRejectedValue(new RelayExecError('exit 1', 1, '', 'no server running'))
    await expect(probeTmuxLiveness('p', 's-dead')).resolves.toBe('dead')
  })

  it('is unknown on a transient transport failure — never a reap signal', async () => {
    sessionExecMock.mockRejectedValue(new RelayDialError('relay dial timeout'))
    await expect(probeTmuxLiveness('p', 's-blip')).resolves.toBe('unknown')
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    sessionExecMock.mockResolvedValue({ stdout: '', stderr: '' })
    const [a, b, c] = await Promise.all([
      probeTmuxLiveness('p', 's-coalesce'),
      probeTmuxLiveness('p', 's-coalesce'),
      probeTmuxLiveness('p', 's-coalesce'),
    ])
    expect([a, b, c]).toEqual(['alive', 'alive', 'alive'])
    expect(sessionExecMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits to alive on a healthy watcher stream — no probe at all', async () => {
    setSessionStreamHealth('p', 's-streamed', true)
    try {
      await expect(probeTmuxLiveness('p', 's-streamed')).resolves.toBe('alive')
      expect(sessionExecMock).not.toHaveBeenCalled()
      // Health gone (stream died) → back to the relay probe.
      setSessionStreamHealth('p', 's-streamed', false)
      sessionExecMock.mockResolvedValue({ stdout: '', stderr: '' })
      await expect(probeTmuxLiveness('p', 's-streamed')).resolves.toBe('alive')
      expect(sessionExecMock).toHaveBeenCalledTimes(1)
    } finally {
      _resetSessionStatusStoreForTests()
    }
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

  async function seedModulesDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'projects', slug, '.cached-packages', 'modules', sid)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  async function seedSessionsDir(slug: string, sid: string): Promise<string> {
    const dir = path.join(dataDir, 'projects', slug, 'sessions', sid)
    await fs.mkdir(dir, { recursive: true })
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

  it('returns quietly if pod listing fails', async () => {
    const dead = await seedModulesDir('proj-a', 'would-be-removed')
    mockListPods.mockRejectedValue(new Error('cluster offline'))

    await expect(gcOrphanEphemeralModuleDirs()).resolves.toBeUndefined()
    // Nothing was removed because we bailed out before the sweep.
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })
})
