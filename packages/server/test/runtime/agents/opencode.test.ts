import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  pickOpencodeSession,
  OPENCODE_BUSY_MARKERS,
  getSessionOpencodeFirstUserMessage,
} from '#runtime/agents/opencode'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { WorktreeDriver } from '#drivers/contract'

const mockedExec = vi.fn<WorktreeDriver['exec']>()

/**
 * The probe (`opencode api … session.list`) goes through the driver's
 * `exec`; the helper installs a dispatching implementation so tests control
 * it. (Busy/idle classification runs inside tmux — the markers are pinned
 * here and validated end-to-end by verify-tmux-status-format.js.)
 */
function mockProbeResult(result: { stdout: string; stderr: string } | Error): void {
  installFakeWorktreeDriver({ exec: mockedExec })
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd.startsWith('opencode api ')) {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    }
    return Promise.reject(new Error('unexpected non-probe exec'))
  })
}

/** What `opencode api --standalone session.list` prints: a page of sessions. */
function sessionsStdout(
  sessions: Array<{ id: string; title?: string; parentID?: string; updated?: number }>,
): { stdout: string; stderr: string } {
  const data = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    parentID: s.parentID,
    projectID: 'p1',
    time: { created: 0, updated: s.updated ?? 0 },
    location: { directory: '/workspace' },
  }))
  return { stdout: JSON.stringify({ data, cursor: { previous: null, next: null } }) + '\n', stderr: '' }
}

describe('opencode-status', () => {
  beforeEach(() => {
    mockedExec.mockReset()
  })
  describe('pickOpencodeSession', () => {
    it('picks the most-recently-updated root session', () => {
      const result = pickOpencodeSession([
        { id: 's1', time: { created: 0, updated: 100 } },
        { id: 's2', time: { created: 0, updated: 500 } },
        { id: 's3', time: { created: 0, updated: 200 } },
      ])
      expect(result?.id).toBe('s2')
    })

    it('prefers root sessions (no parentID) over forks', () => {
      const result = pickOpencodeSession([
        { id: 'fork', parentID: 's-root', time: { created: 0, updated: 1000 } },
        { id: 's-root', time: { created: 0, updated: 100 } },
      ])
      expect(result?.id).toBe('s-root')
    })

    it('falls back to any session if no roots are present', () => {
      const result = pickOpencodeSession([
        { id: 'fork-a', parentID: 'missing', time: { created: 0, updated: 100 } },
        { id: 'fork-b', parentID: 'missing', time: { created: 0, updated: 500 } },
      ])
      expect(result?.id).toBe('fork-b')
    })

    it('returns undefined for an empty session list', () => {
      expect(pickOpencodeSession([])).toBeUndefined()
    })
  })

  describe('OPENCODE_BUSY_MARKERS', () => {
    it('pins the tmux-ERE busy markers the status format searches for', () => {
      // These are encoded into a tmux content-search format by
      // busyStatusFormat (status-watcher.ts) and validated against a live
      // tmux by test-playwright-scripts/verify-tmux-status-format.js. The
      // interrupt hint covers "esc interrupt" / "esc again to interrupt";
      // the strip is 4+ ■/⬝ cells (short runs in transcript text don't count).
      expect(OPENCODE_BUSY_MARKERS).toEqual([
        'esc\\s+(again\\s+to\\s+)?interrupt',
        '[■⬝][■⬝][■⬝][■⬝]',
      ])
    })
  })

  describe('getSessionOpencodeFirstUserMessage', () => {
    it('returns the title of the worktree\'s session', async () => {
      mockProbeResult(sessionsStdout([{ id: 'ses_1', title: 'Refactor auth flow', updated: 1 }]))
      expect(await getSessionOpencodeFirstUserMessage('container')).toBe('Refactor auth flow')
    })

    it('returns undefined while the session has no title yet', async () => {
      mockProbeResult(sessionsStdout([{ id: 'ses_1', updated: 1 }]))
      expect(await getSessionOpencodeFirstUserMessage('container')).toBeUndefined()
    })

    it('returns undefined when the probe yields no session', async () => {
      mockProbeResult(sessionsStdout([]))
      expect(await getSessionOpencodeFirstUserMessage('container')).toBeUndefined()
    })

    it('returns undefined when the probe fails', async () => {
      mockProbeResult(new Error('exec failed'))
      expect(await getSessionOpencodeFirstUserMessage('container')).toBeUndefined()
    })
  })
})
