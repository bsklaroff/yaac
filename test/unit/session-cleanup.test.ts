import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type ChildProcessModule from 'node:child_process'

// Pod/Job listing is mocked (gcOrphanEphemeralModuleDirs reads it);
// sessionJobName stays real so the tmux-probe argv assertions hold.
vi.mock('@/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
    listSessionJobs: vi.fn(),
  }
})

const execFileMock = vi.fn<(cmd: string, args: string[], opts: unknown) => Promise<void>>()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      // promisify(execFile) always invokes the 4-arg form with opts.
      execFileMock(cmd, args, opts).then(
        () => { cb(null, '', '') },
        (err: Error) => { cb(err, '', '') },
      )
    },
  }
})

import { listSessionPods, listSessionJobs } from '@/lib/k8s/pods'
import type * as podsModule from '@/lib/k8s/pods'
import {
  isTmuxSessionAlive,
  cleanupSession,
  cleanupSessionDetached,
  sessionModulesDir,
  gcOrphanEphemeralModuleDirs,
  _clearTmuxAliveCacheForTests,
} from '@/lib/session/cleanup'
import { setDataDir } from '@/lib/project/paths'

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
    createdAtMs: 0,
    labels: {},
  }
}

describe('isTmuxSessionAlive', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execFileMock.mockReset()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxalive-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setProbeResult(slug: string, sid: string, alive: boolean): void {
    const target = `job/yaac-${slug}-${sid}`
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'exec' && args.includes(target)) {
        return alive ? Promise.resolve() : Promise.reject(new Error('has-session: no such session'))
      }
      return Promise.reject(new Error('unexpected execFile call'))
    })
  }

  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
  })

  it('returns true when has-session exits 0', async () => {
    setProbeResult('p', 's-up', true)
    await expect(isTmuxSessionAlive('p', 's-up')).resolves.toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      'kubectl',
      [
        'exec', '-n', 'yaac', 'job/yaac-p-s-up', '--',
        'tmux', '-S', '/tmp/yaac-tmux/server', 'has-session', '-t', 'yaac',
      ],
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
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('caches per (slug, sid), not globally', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      return args.includes('job/yaac-p-s-a')
        ? Promise.resolve()
        : Promise.reject(new Error('no session'))
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

describe('cleanupSession', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSession).toBe('function')
  })
})

describe('cleanupSessionDetached', () => {
  it('is exported as a function', () => {
    expect(typeof cleanupSessionDetached).toBe('function')
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
