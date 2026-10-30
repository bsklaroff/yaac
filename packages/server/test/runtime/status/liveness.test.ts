import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  _clearSetupDoneCacheForTests,
  _clearTmuxAliveCacheForTests,
  forgetLiveness,
  isTmuxSessionAlive,
  probeSetupState,
  probeTmuxLiveness,
} from '#runtime/status/liveness'
import {
  _resetWorkspaceStatusStoreForTests,
  setWorkspaceStreamHealth,
} from '#runtime/status/status-store'
import { setDataDir } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'

// Every probe is one driver `exec` into the workspace, so only the driver
// is mocked. Any error other than a probe result is a transport failure.
const execMock = vi.fn<WorkspaceDriver['exec']>()
const transportFailure = (msg: string): Error => new Error(msg)

/** The identity + unit name a probe addresses, by this suite's convention. */
function target(projectId: string, sid: string): {
  projectId: string
  workspaceId: string
  jobName: string
} {
  return { projectId: projectId, workspaceId: sid, jobName: `yaac-${projectId}-${sid}` }
}

describe('isTmuxSessionAlive', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execMock.mockReset()
    installFakeWorkspaceDriver({ exec: execMock })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxalive-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setProbeResult(projectId: string, sid: string, alive: boolean): void {
    const job = `yaac-${projectId}-${sid}`
    execMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('has-session')) {
        return alive
          ? Promise.resolve({ stdout: '', stderr: '' })
          : Promise.reject(new WorkspaceExecError('exit 1', 1, '', "can't find session: yaac"))
      }
      return Promise.reject(transportFailure('unexpected exec call'))
    })
  }

  it('returns true when has-session exits 0', async () => {
    setProbeResult('p', 's-up', true)
    await expect(isTmuxSessionAlive(target('p', 's-up'))).resolves.toBe(true)
    expect(execMock).toHaveBeenCalledWith(
      'yaac-p-s-up',
      'tmux -S /tmp/yaac-tmux/server has-session -t yaac',
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    )
  })

  it('returns false when has-session exits non-zero', async () => {
    setProbeResult('p', 's-absent', false)
    await expect(isTmuxSessionAlive(target('p', 's-absent'))).resolves.toBe(false)
  })

  it('serves repeat calls from the TTL cache without re-probing', async () => {
    setProbeResult('p', 's-cache', true)
    expect(await isTmuxSessionAlive(target('p', 's-cache'))).toBe(true)
    // Within the TTL the cached value wins.
    setProbeResult('p', 's-cache', false)
    expect(await isTmuxSessionAlive(target('p', 's-cache'))).toBe(true)
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    setProbeResult('p', 's-coalesce', true)
    const p1 = isTmuxSessionAlive(target('p', 's-coalesce'))
    const p2 = isTmuxSessionAlive(target('p', 's-coalesce'))
    const p3 = isTmuxSessionAlive(target('p', 's-coalesce'))
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true])
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('caches per (projectId, sid), not globally', async () => {
    execMock.mockImplementation((jobName) => {
      return jobName === 'yaac-p-s-a'
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new WorkspaceExecError('exit 1', 1, '', 'no session'))
    })
    expect(await isTmuxSessionAlive(target('p', 's-a'))).toBe(true)
    expect(await isTmuxSessionAlive(target('p', 's-b'))).toBe(false)
  })

  // Called at teardown so a later workspace reusing the id starts fresh.
  it('forgetLiveness drops the cache entry for that session', async () => {
    setProbeResult('p', 's-evict', true)
    expect(await isTmuxSessionAlive(target('p', 's-evict'))).toBe(true)

    forgetLiveness('p', 's-evict')

    setProbeResult('p', 's-evict', false)
    expect(await isTmuxSessionAlive(target('p', 's-evict'))).toBe(false)
  })
})
describe('probeSetupState', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearSetupDoneCacheForTests()
    execMock.mockReset()
    installFakeWorkspaceDriver({ exec: execMock })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-setup-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setPaneCommand(projectId: string, sid: string, command: string | Error): void {
    const job = `yaac-${projectId}-${sid}`
    execMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('display-message')) {
        return command instanceof Error
          ? Promise.reject(command)
          : Promise.resolve({ stdout: `${command}\n`, stderr: '' })
      }
      return Promise.reject(transportFailure('unexpected exec call'))
    })
  }

  it('reports a keeper still named for its start as starting, reading the first window', async () => {
    setPaneCommand('p', 's-half', '_yaac-starting')
    await expect(probeSetupState(target('p', 's-half'))).resolves.toBe('starting')
    expect(execMock).toHaveBeenCalledWith(
      'yaac-p-s-half',
      "tmux -S /tmp/yaac-tmux/server display-message -p -t 'yaac:^' '#{window_name}'",
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    )
  })

  // A workspace from before keepers runs its agent in its first window.
  it('reports the renamed keeper, or any other first window, as done', async () => {
    setPaneCommand('p', 's-live', '_yaac')
    await expect(probeSetupState(target('p', 's-live'))).resolves.toBe('done')
    setPaneCommand('p', 's-old', 'claude')
    await expect(probeSetupState(target('p', 's-old'))).resolves.toBe('done')
  })

  it('memoizes a done verdict and never re-probes it', async () => {
    setPaneCommand('p', 's-memo', '_yaac')
    await expect(probeSetupState(target('p', 's-memo'))).resolves.toBe('done')
    // `done` is final: no further exec.
    setPaneCommand('p', 's-memo', '_yaac-starting')
    await expect(probeSetupState(target('p', 's-memo'))).resolves.toBe('done')
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('reports unknown on a probe failure, and keeps re-probing', async () => {
    setPaneCommand('p', 's-blip', new Error('exec timed out'))
    await expect(probeSetupState(target('p', 's-blip'))).resolves.toBe('unknown')
    setPaneCommand('p', 's-blip', '_yaac-starting')
    await expect(probeSetupState(target('p', 's-blip'))).resolves.toBe('starting')
  })

  it('forgetLiveness drops the memoized verdict for that session', async () => {
    setPaneCommand('p', 's-evict2', '_yaac')
    await expect(probeSetupState(target('p', 's-evict2'))).resolves.toBe('done')

    forgetLiveness('p', 's-evict2')

    setPaneCommand('p', 's-evict2', '_yaac-starting')
    await expect(probeSetupState(target('p', 's-evict2'))).resolves.toBe('starting')
  })
})
describe('probeTmuxLiveness', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execMock.mockReset()
    installFakeWorkspaceDriver({ exec: execMock })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxprobe-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('is alive when has-session exits 0', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(probeTmuxLiveness(target('p', 's-alive'))).resolves.toBe('alive')
  })

  it('is dead when the remote tmux exits non-zero', async () => {
    execMock.mockRejectedValue(new WorkspaceExecError('exit 1', 1, '', 'no server running'))
    await expect(probeTmuxLiveness(target('p', 's-dead'))).resolves.toBe('dead')
  })

  // Only a probe that reached the workspace can prove it dead.
  it('is unknown on a transport failure or a detail-less error — never a reap signal', async () => {
    const errors = [transportFailure('relay dial timeout'), transportFailure('stream read timeout after 2000ms'),
      new Error('boom'), undefined, null]
    for (const [i, err] of errors.entries()) {
      execMock.mockRejectedValue(err)
      await expect(probeTmuxLiveness(target('p', `s-blip-${String(i)}`))).resolves.toBe('unknown')
    }
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '' })
    const [a, b, c] = await Promise.all([
      probeTmuxLiveness(target('p', 's-coalesce')),
      probeTmuxLiveness(target('p', 's-coalesce')),
      probeTmuxLiveness(target('p', 's-coalesce')),
    ])
    expect([a, b, c]).toEqual(['alive', 'alive', 'alive'])
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits to alive on a healthy watcher stream — no probe at all', async () => {
    setWorkspaceStreamHealth('p', 's-streamed', true)
    try {
      await expect(probeTmuxLiveness(target('p', 's-streamed'))).resolves.toBe('alive')
      expect(execMock).not.toHaveBeenCalled()
      // Stream died, so probing resumes.
      setWorkspaceStreamHealth('p', 's-streamed', false)
      execMock.mockResolvedValue({ stdout: '', stderr: '' })
      await expect(probeTmuxLiveness(target('p', 's-streamed'))).resolves.toBe('alive')
      expect(execMock).toHaveBeenCalledTimes(1)
    } finally {
      _resetWorkspaceStatusStoreForTests()
    }
  })
})
