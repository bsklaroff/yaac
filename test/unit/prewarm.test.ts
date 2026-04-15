import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import {
  readPrewarmSessions,
  getPrewarmSession,
  setPrewarmSession,
  clearPrewarmSession,
  clearFailedPrewarmSessions,
  isPrewarmSession,
  MAX_STALE_MS,
} from '@/lib/prewarm'
import type { PrewarmEntry } from '@/lib/prewarm'

describe('prewarm state helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-prewarm-test-'))
    setDataDir(tmpDir)
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
})
