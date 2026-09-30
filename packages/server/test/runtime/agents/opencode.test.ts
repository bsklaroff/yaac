import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  OPENCODE_BUSY_MARKERS,
  getSessionOpencodeFirstUserMessage,
} from '#runtime/agents/opencode'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { WorkspaceDriver } from '#drivers/contract'

const mockedExec = vi.fn<WorkspaceDriver['exec']>()

/**
 * The probe (`opencode api … session.get`) goes through the driver's `exec`;
 * the helper installs an implementation that answers for one session id and
 * 404s (exit 1) for any other. (Busy/idle classification runs inside tmux —
 * the markers are pinned here and validated end-to-end by
 * verify-tmux-status-format.js.)
 */
function mockSession(id: string, reply: { title?: string } | Error): void {
  installFakeWorkspaceDriver({ exec: mockedExec })
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd !== `opencode api --standalone session.get --param sessionID=${id}`) {
      return Promise.reject(new Error('HTTP 404 Not Found'))
    }
    if (reply instanceof Error) return Promise.reject(reply)
    // What `session.get` prints: the session, with no `title` key until
    // opencode has titled it.
    const data = { id, ...reply, projectID: 'p1', time: { created: 0, updated: 0 } }
    return Promise.resolve({ stdout: JSON.stringify({ data }) + '\n', stderr: '' })
  })
}

describe('opencode-status', () => {
  beforeEach(() => {
    mockedExec.mockReset()
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
    it('returns the title of the session the row names, fetched by id', async () => {
      // Fetched rather than picked out of `session.list`, whose page holds
      // only the 50 most recently updated: a workspace with more still labels
      // each conversation by its own title.
      mockSession('ses_old', { title: 'OLIVE' })
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_old')).toBe('OLIVE')
      expect(mockedExec.mock.calls[0]?.[0]).toBe('container')
    })

    it('never borrows another session\'s title', async () => {
      mockSession('ses_old', { title: 'OLIVE' })
      // An id opencode lacks: `session.get` exits 1.
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_gone')).toBeUndefined()
      // The workspace-id pin, and no id at all, name no opencode session.
      expect(await getSessionOpencodeFirstUserMessage('container', 'wt-1')).toBeUndefined()
      expect(await getSessionOpencodeFirstUserMessage('container')).toBeUndefined()
      // Nor does a malformed `ses_` id, which is never put on a command line.
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_foo-bar')).toBeUndefined()
      expect(mockedExec.mock.calls.map(([, cmd]) => cmd))
        .toEqual(['opencode api --standalone session.get --param sessionID=ses_gone'])
    })

    it('returns undefined while the session has no title yet', async () => {
      mockSession('ses_1', {})
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_1')).toBeUndefined()
    })

    it('returns undefined when the probe fails', async () => {
      mockSession('ses_1', new Error('exec failed'))
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_1')).toBeUndefined()
    })
  })
})
