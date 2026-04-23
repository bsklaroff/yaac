import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('@/lib/session/cleanup', () => ({
  cleanupSession: vi.fn(),
  isTmuxSessionAlive: vi.fn().mockResolvedValue(false),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/container/runtime', () => ({
  podman: { listContainers: vi.fn().mockResolvedValue([]), getContainer: vi.fn() },
  podmanExecWithRetry: vi.fn(),
  shellPodmanWithRetry: vi.fn(),
}))

import { setDataDir } from '@/lib/project/paths'
import {
  readPrewarmSessions,
  getPrewarmSession,
  setPrewarmSession,
  clearPrewarmSession,
  clearFailedPrewarmSessions,
  claimPrewarmSession,
  isPrewarmSession,
  updatePrewarmSessionIfMatch,
  MAX_STALE_MS,
} from '@/lib/prewarm'
import { cleanupSession, isTmuxSessionAlive } from '@/lib/session/cleanup'
import { podmanExecWithRetry } from '@/lib/container/runtime'
import type { PrewarmEntry } from '@/lib/prewarm'

const mockCleanupSession = vi.mocked(cleanupSession)
const mockPodmanExec = vi.mocked(podmanExecWithRetry)
const mockIsTmuxSessionAlive = vi.mocked(isTmuxSessionAlive)

describe('prewarm state helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-prewarm-test-'))
    setDataDir(tmpDir)
    mockCleanupSession.mockReset()
    mockCleanupSession.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    setDataDir(path.join(os.homedir(), '.yaac'))
  })

  const entry: PrewarmEntry = {
    sessionId: 'test-session-id',
    containerName: 'yaac-test-session-id',
    fingerprint: 'abc123',
    state: 'ready',
    verifiedAt: Date.now(),
  }

  it('readPrewarmSessions returns empty object when file is missing', async () => {
    const data = await readPrewarmSessions()
    expect(data).toEqual({})
  })

  it('setPrewarmSession writes and getPrewarmSession reads', async () => {
    await setPrewarmSession('my-project', entry)
    const result = await getPrewarmSession('my-project')
    expect(result).toEqual(entry)
  })

  it('getPrewarmSession returns null for missing project', async () => {
    await setPrewarmSession('my-project', entry)
    const result = await getPrewarmSession('other-project')
    expect(result).toBeNull()
  })

  it('clearPrewarmSession removes the entry', async () => {
    await setPrewarmSession('my-project', entry)
    await clearPrewarmSession('my-project')
    const result = await getPrewarmSession('my-project')
    expect(result).toBeNull()
  })

  it('clearPrewarmSession is a no-op for missing entry', async () => {
    await clearPrewarmSession('nonexistent')
    const data = await readPrewarmSessions()
    expect(data).toEqual({})
  })

  it('setPrewarmSession preserves other projects', async () => {
    await setPrewarmSession('project-a', entry)
    await setPrewarmSession('project-b', { ...entry, sessionId: 'other-id' })
    const a = await getPrewarmSession('project-a')
    const b = await getPrewarmSession('project-b')
    expect(a?.sessionId).toBe('test-session-id')
    expect(b?.sessionId).toBe('other-id')
  })

  it('isPrewarmSession returns true for matching sessionId', async () => {
    await setPrewarmSession('my-project', entry)
    expect(await isPrewarmSession('my-project', 'test-session-id')).toBe(true)
  })

  it('isPrewarmSession returns false for non-matching sessionId', async () => {
    await setPrewarmSession('my-project', entry)
    expect(await isPrewarmSession('my-project', 'wrong-id')).toBe(false)
  })

  it('isPrewarmSession returns false when no entry exists', async () => {
    expect(await isPrewarmSession('my-project', 'test-session-id')).toBe(false)
  })

  it('MAX_STALE_MS is 30 seconds', () => {
    expect(MAX_STALE_MS).toBe(30_000)
  })

  it('getPrewarmSession returns failed entry', async () => {
    const failedEntry: PrewarmEntry = {
      ...entry,
      state: 'failed',
    }
    await setPrewarmSession('my-project', failedEntry)
    const result = await getPrewarmSession('my-project')
    expect(result).toEqual(failedEntry)
    expect(result?.state).toBe('failed')
  })

  it('isPrewarmSession returns true for failed entry with matching sessionId', async () => {
    const failedEntry: PrewarmEntry = {
      ...entry,
      state: 'failed',
    }
    await setPrewarmSession('my-project', failedEntry)
    expect(await isPrewarmSession('my-project', 'test-session-id')).toBe(true)
  })

  it('failed entry preserves fingerprint for retry gating', async () => {
    const failedEntry: PrewarmEntry = {
      ...entry,
      state: 'failed',
      fingerprint: 'fail-fp-123',
    }
    await setPrewarmSession('my-project', failedEntry)
    const result = await getPrewarmSession('my-project')
    expect(result?.fingerprint).toBe('fail-fp-123')
    expect(result?.state).toBe('failed')
  })

  it('clearFailedPrewarmSessions removes only failed entries', async () => {
    const readyEntry: PrewarmEntry = { ...entry, state: 'ready' }
    const failedEntry: PrewarmEntry = { ...entry, state: 'failed', sessionId: 'failed-id' }
    await setPrewarmSession('project-ok', readyEntry)
    await setPrewarmSession('project-bad', failedEntry)

    await clearFailedPrewarmSessions()

    const data = await readPrewarmSessions()
    expect(data['project-ok']).toEqual(readyEntry)
    expect(data['project-bad']).toBeUndefined()
  })

  it('clearFailedPrewarmSessions is a no-op when no failed entries', async () => {
    await setPrewarmSession('my-project', entry)
    await clearFailedPrewarmSessions()
    const result = await getPrewarmSession('my-project')
    expect(result).toEqual(entry)
    expect(mockCleanupSession).not.toHaveBeenCalled()
  })

  it('clearFailedPrewarmSessions tears down each failed container', async () => {
    const failedA: PrewarmEntry = {
      ...entry,
      state: 'failed',
      sessionId: 'sess-a',
      containerName: 'yaac-proj-a-sess-a',
    }
    const failedB: PrewarmEntry = {
      ...entry,
      state: 'failed',
      sessionId: 'sess-b',
      containerName: 'yaac-proj-b-sess-b',
    }
    const ready: PrewarmEntry = { ...entry, state: 'ready' }
    await setPrewarmSession('proj-a', failedA)
    await setPrewarmSession('proj-b', failedB)
    await setPrewarmSession('proj-ok', ready)

    await clearFailedPrewarmSessions()

    expect(mockCleanupSession).toHaveBeenCalledTimes(2)
    expect(mockCleanupSession).toHaveBeenCalledWith({
      containerName: 'yaac-proj-a-sess-a',
      projectSlug: 'proj-a',
      sessionId: 'sess-a',
    })
    expect(mockCleanupSession).toHaveBeenCalledWith({
      containerName: 'yaac-proj-b-sess-b',
      projectSlug: 'proj-b',
      sessionId: 'sess-b',
    })
  })

  it('clearFailedPrewarmSessions swallows cleanup errors', async () => {
    mockCleanupSession.mockRejectedValue(new Error('podman blew up'))
    const failed: PrewarmEntry = { ...entry, state: 'failed' }
    await setPrewarmSession('my-project', failed)

    await expect(clearFailedPrewarmSessions()).resolves.toBeUndefined()

    const result = await getPrewarmSession('my-project')
    expect(result).toBeNull()
  })

  it('setPrewarmSession stores tool field', async () => {
    const codexEntry: PrewarmEntry = { ...entry, tool: 'codex' }
    await setPrewarmSession('my-project', codexEntry)
    const result = await getPrewarmSession('my-project')
    expect(result?.tool).toBe('codex')
  })

  it('tool defaults to undefined for legacy entries', async () => {
    await setPrewarmSession('my-project', entry)
    const result = await getPrewarmSession('my-project')
    expect(result?.tool).toBeUndefined()
  })

  it('failed entry is replaced when fingerprint changes', async () => {
    const failedEntry: PrewarmEntry = {
      ...entry,
      state: 'failed',
      fingerprint: 'old-fp',
    }
    await setPrewarmSession('my-project', failedEntry)

    const newEntry: PrewarmEntry = {
      ...entry,
      state: 'creating',
      fingerprint: 'new-fp',
    }
    await setPrewarmSession('my-project', newEntry)

    const result = await getPrewarmSession('my-project')
    expect(result?.state).toBe('creating')
    expect(result?.fingerprint).toBe('new-fp')
  })

  /**
   * Core invariant for the monitor refresh + claim race. Without a
   * compare-and-set guard, `ensurePrewarmSession`'s verifiedAt refresh
   * could read `existing`, do a slow alive-check, and then blindly
   * re-write `existing` — resurrecting an entry that a concurrent
   * `claimPrewarmSession` cleared between the read and the write. The
   * claimed container would then stay labeled `prewarm` forever.
   */
  it('updatePrewarmSessionIfMatch no-ops when the entry was cleared', async () => {
    await setPrewarmSession('my-project', entry)
    await clearPrewarmSession('my-project')

    const applied = await updatePrewarmSessionIfMatch('my-project', entry.sessionId, {
      ...entry,
      verifiedAt: Date.now() + 10_000,
    })

    expect(applied).toBe(false)
    expect(await getPrewarmSession('my-project')).toBeNull()
  })

  it('updatePrewarmSessionIfMatch no-ops when the sessionId no longer matches', async () => {
    const replaced: PrewarmEntry = { ...entry, sessionId: 'replacement-id' }
    await setPrewarmSession('my-project', replaced)

    const applied = await updatePrewarmSessionIfMatch('my-project', 'old-sess-id', {
      ...replaced,
      verifiedAt: Date.now() + 10_000,
    })

    expect(applied).toBe(false)
    const current = await getPrewarmSession('my-project')
    expect(current?.sessionId).toBe('replacement-id')
  })

  it('updatePrewarmSessionIfMatch writes when the sessionId still matches', async () => {
    await setPrewarmSession('my-project', entry)
    const refreshed: PrewarmEntry = { ...entry, verifiedAt: entry.verifiedAt + 10_000 }

    const applied = await updatePrewarmSessionIfMatch('my-project', entry.sessionId, refreshed)

    expect(applied).toBe(true)
    const current = await getPrewarmSession('my-project')
    expect(current?.verifiedAt).toBe(refreshed.verifiedAt)
  })

  /**
   * When a prewarm creation is in flight (state='creating') and a claimer
   * races in, the claimer clears the state and polls the container via
   * waitForContainer. If creation later aborts and `podman rm -f`s the
   * half-created container, waitForContainer must return immediately
   * instead of polling a now-deleted container for the full 120s timeout.
   * The previous behavior burned the full 2-minute budget and surfaced as
   * a user-visible hang on `yaac session stream` after an exited container.
   */
  it('claimPrewarmSession aborts fast when creation is abandoned', async () => {
    const creatingEntry: PrewarmEntry = {
      ...entry,
      state: 'creating',
      verifiedAt: Date.now(),
    }
    await setPrewarmSession('my-project', creatingEntry)

    // First two inspects: container exists+running. Then it's removed, so
    // inspect throws (dockerode surfaces the "no such container" errno via
    // podmanExecWithRetry rejecting). Tmux is never alive — the claude
    // crash path that motivates this test means tmux exits right after
    // the container came up.
    let inspectCalls = 0
    mockPodmanExec.mockImplementation((args) => {
      if (args[0] === 'inspect') {
        inspectCalls += 1
        if (inspectCalls <= 2) {
          return Promise.resolve({ stdout: 'true\n', stderr: '' })
        }
        return Promise.reject(new Error('no such container'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    mockIsTmuxSessionAlive.mockResolvedValue(false)

    const started = Date.now()
    const result = await claimPrewarmSession('my-project')
    const elapsed = Date.now() - started

    expect(result).toBeNull()
    // Two "exists" polls + one "gone" poll = ~3 seconds of sleeps, well
    // under the 120s timeout the old behavior would hit.
    expect(elapsed).toBeLessThan(15_000)
    expect(inspectCalls).toBeGreaterThanOrEqual(3)
  })
})
