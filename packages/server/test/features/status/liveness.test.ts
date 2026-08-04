import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Mocked at the process boundary: every probe in here is one relay exec into
// the session pod, so the relay is the only thing that needs standing in.
vi.mock('#platform/k8s/stream-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof relayModule>()
  return { ...actual, sessionExec: vi.fn() }
})

import { RelayDialError, RelayExecError, sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import {
  _clearAgentStartedCacheForTests,
  _clearTmuxAliveCacheForTests,
  classifyTmuxProbeError,
  forgetLiveness,
  isTmuxSessionAlive,
  probeAgentPaneState,
  probeTmuxLiveness,
} from '#features/status/liveness'
import {
  _resetSessionStatusStoreForTests,
  setSessionStreamHealth,
} from '#features/status/status-store'
import { setDataDir } from '@yaac/shared/project-paths'

const sessionExecMock = vi.mocked(sessionExec)

describe('isTmuxSessionAlive', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearTmuxAliveCacheForTests()
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

  // Session teardown calls forgetLiveness so a later probe can't read a
  // verdict belonging to a session that is gone — or to a new one that
  // reused the id.
  it('forgetLiveness drops the cache entry for that session', async () => {
    setProbeResult('p', 's-evict', true)
    expect(await isTmuxSessionAlive('p', 's-evict')).toBe(true)

    forgetLiveness('p', 's-evict')

    // Cache is gone — flip the probe and observe that the next call re-runs.
    setProbeResult('p', 's-evict', false)
    expect(await isTmuxSessionAlive('p', 's-evict')).toBe(false)
  })
})
describe('probeAgentPaneState', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearAgentStartedCacheForTests()
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

  it('forgetLiveness drops the memoized verdict for that session', async () => {
    setPaneCommand('p', 's-evict2', 'claude')
    await expect(probeAgentPaneState('p', 's-evict2')).resolves.toBe('started')

    forgetLiveness('p', 's-evict2')

    setPaneCommand('p', 's-evict2', 'sleep')
    await expect(probeAgentPaneState('p', 's-evict2')).resolves.toBe('placeholder')
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
