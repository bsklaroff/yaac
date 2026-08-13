import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  _clearAgentStartedCacheForTests,
  _clearTmuxAliveCacheForTests,
  classifyTmuxProbeError,
  forgetLiveness,
  isTmuxSessionAlive,
  probeAgentPaneState,
  probeTmuxLiveness,
} from '#runtime/status/liveness'
import {
  _resetWorktreeStatusStoreForTests,
  setWorktreeStreamHealth,
} from '#runtime/status/status-store'
import { setDataDir } from '@yaac/shared/project-paths'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { WorkspaceExecError, type WorktreeDriver } from '#drivers/contract'

// Mocked at the contract boundary: every probe in here is one `exec` into
// the workspace, so the registered driver is the only thing that needs
// standing in. A transport failure is any other error — what a driver
// throws when it never reached the workspace at all.
const execMock = vi.fn<WorktreeDriver['exec']>()
const transportFailure = (msg: string): Error => new Error(msg)

/** The identity + unit name a probe addresses, by this suite's convention. */
function target(slug: string, sid: string): {
  projectSlug: string
  workspaceId: string
  jobName: string
} {
  return { projectSlug: slug, workspaceId: sid, jobName: `yaac-${slug}-${sid}` }
}

describe('isTmuxSessionAlive', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
    execMock.mockReset()
    installFakeWorktreeDriver({ exec: execMock })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmuxalive-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setProbeResult(slug: string, sid: string, alive: boolean): void {
    const job = `yaac-${slug}-${sid}`
    execMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('has-session')) {
        return alive
          ? Promise.resolve({ stdout: '', stderr: '' })
          : Promise.reject(new WorkspaceExecError('exit 1', 1, '', "can't find session: yaac"))
      }
      return Promise.reject(transportFailure('unexpected exec call'))
    })
  }

  it('is exported as a function', () => {
    expect(typeof isTmuxSessionAlive).toBe('function')
  })

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
    // Flip the probe result — the cache should still return the old value within TTL.
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

  it('caches per (slug, sid), not globally', async () => {
    execMock.mockImplementation((jobName) => {
      return jobName === 'yaac-p-s-a'
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new WorkspaceExecError('exit 1', 1, '', 'no session'))
    })
    expect(await isTmuxSessionAlive(target('p', 's-a'))).toBe(true)
    expect(await isTmuxSessionAlive(target('p', 's-b'))).toBe(false)
  })

  // Session teardown calls forgetLiveness so a later probe can't read a
  // verdict belonging to a session that is gone — or to a new one that
  // reused the id.
  it('forgetLiveness drops the cache entry for that session', async () => {
    setProbeResult('p', 's-evict', true)
    expect(await isTmuxSessionAlive(target('p', 's-evict'))).toBe(true)

    forgetLiveness('p', 's-evict')

    // Cache is gone — flip the probe and observe that the next call re-runs.
    setProbeResult('p', 's-evict', false)
    expect(await isTmuxSessionAlive(target('p', 's-evict'))).toBe(false)
  })
})
describe('probeAgentPaneState', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearAgentStartedCacheForTests()
    execMock.mockReset()
    installFakeWorktreeDriver({ exec: execMock })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agentpane-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function setPaneCommand(slug: string, sid: string, command: string | Error): void {
    const job = `yaac-${slug}-${sid}`
    execMock.mockImplementation((jobName, cmd) => {
      if (jobName === job && cmd.includes('display-message')) {
        return command instanceof Error
          ? Promise.reject(command)
          : Promise.resolve({ stdout: `${command}\n`, stderr: '' })
      }
      return Promise.reject(transportFailure('unexpected exec call'))
    })
  }

  it('reports the sleep keepalive as placeholder, targeting the first window', async () => {
    setPaneCommand('p', 's-half', 'sleep')
    await expect(probeAgentPaneState(target('p', 's-half'))).resolves.toBe('placeholder')
    expect(execMock).toHaveBeenCalledWith(
      'yaac-p-s-half',
      "tmux -S /tmp/yaac-tmux/server display-message -p -t 'yaac:^' '#{pane_current_command}'",
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    )
  })

  it('reports any other pane command as started', async () => {
    setPaneCommand('p', 's-live', 'claude')
    await expect(probeAgentPaneState(target('p', 's-live'))).resolves.toBe('started')
  })

  it('memoizes a started verdict and never re-probes it', async () => {
    setPaneCommand('p', 's-memo', 'claude')
    await expect(probeAgentPaneState(target('p', 's-memo'))).resolves.toBe('started')
    // Even a later sleep-looking probe result can't demote it (respawn -k
    // killed the placeholder; started is terminal) — and no exec runs.
    setPaneCommand('p', 's-memo', 'sleep')
    await expect(probeAgentPaneState(target('p', 's-memo'))).resolves.toBe('started')
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('reports unknown on a probe failure, and keeps re-probing', async () => {
    setPaneCommand('p', 's-blip', new Error('exec timed out'))
    await expect(probeAgentPaneState(target('p', 's-blip'))).resolves.toBe('unknown')
    setPaneCommand('p', 's-blip', 'sleep')
    await expect(probeAgentPaneState(target('p', 's-blip'))).resolves.toBe('placeholder')
  })

  it('forgetLiveness drops the memoized verdict for that session', async () => {
    setPaneCommand('p', 's-evict2', 'claude')
    await expect(probeAgentPaneState(target('p', 's-evict2'))).resolves.toBe('started')

    forgetLiveness('p', 's-evict2')

    setPaneCommand('p', 's-evict2', 'sleep')
    await expect(probeAgentPaneState(target('p', 's-evict2'))).resolves.toBe('placeholder')
  })
})
describe('classifyTmuxProbeError', () => {
  it('is dead only when the probe reached the pod and tmux exited non-zero', () => {
    // streamd ran tmux and it reported the session absent — conclusive.
    expect(classifyTmuxProbeError(
      new WorkspaceExecError('exit 1', 1, '', "can't find session: yaac"),
    )).toBe('dead')
  })

  it('is unknown on transport failures — never a reap signal', () => {
    expect(classifyTmuxProbeError(transportFailure('relay refused'))).toBe('unknown')
    expect(classifyTmuxProbeError(transportFailure('stream read timeout after 2000ms'))).toBe('unknown')
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
    execMock.mockReset()
    installFakeWorktreeDriver({ exec: execMock })
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

  it('is unknown on a transient transport failure — never a reap signal', async () => {
    execMock.mockRejectedValue(transportFailure('relay dial timeout'))
    await expect(probeTmuxLiveness(target('p', 's-blip'))).resolves.toBe('unknown')
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
    setWorktreeStreamHealth('p', 's-streamed', true)
    try {
      await expect(probeTmuxLiveness(target('p', 's-streamed'))).resolves.toBe('alive')
      expect(execMock).not.toHaveBeenCalled()
      // Health gone (stream died) → back to the relay probe.
      setWorktreeStreamHealth('p', 's-streamed', false)
      execMock.mockResolvedValue({ stdout: '', stderr: '' })
      await expect(probeTmuxLiveness(target('p', 's-streamed'))).resolves.toBe('alive')
      expect(execMock).toHaveBeenCalledTimes(1)
    } finally {
      _resetWorktreeStatusStoreForTests()
    }
  })
})
