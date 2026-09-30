import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  OPENCODE_BUSY_MARKERS,
  getSessionOpencodeFirstUserMessage,
} from '#runtime/agents/opencode'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { WorkspaceDriver } from '#drivers/contract'

const mockedExec = vi.fn<WorkspaceDriver['exec']>()

/**
 * Mock the driver's `exec` so `opencode api … session.get` answers for one
 * session id and exits 1 for any other.
 */
function mockSession(id: string, reply: { title?: string } | Error): void {
  installFakeWorkspaceDriver({ exec: mockedExec })
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd !== `opencode api --standalone session.get --param sessionID=${id}`) {
      return Promise.reject(new Error('HTTP 404 Not Found'))
    }
    if (reply instanceof Error) return Promise.reject(reply)
    // No `title` key until opencode has titled the session.
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
      // Turned into a tmux format by busyStatusFormat (agent-tools.ts);
      // test-playwright-scripts/verify-tmux-status-format.js checks them
      // against a live tmux. The progress strip needs 4+ cells so short
      // runs in transcript text do not match.
      expect(OPENCODE_BUSY_MARKERS).toEqual([
        'esc\\s+(again\\s+to\\s+)?interrupt',
        '[■⬝][■⬝][■⬝][■⬝]',
      ])
    })
  })

  describe('getSessionOpencodeFirstUserMessage', () => {
    it('returns the title of the session the row names, fetched by id', async () => {
      // Fetched by id because `session.list` returns only the 50 most
      // recently updated.
      mockSession('ses_old', { title: 'OLIVE' })
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_old')).toBe('OLIVE')
      expect(mockedExec.mock.calls[0]?.[0]).toBe('container')
    })

    it('never borrows another session\'s title', async () => {
      mockSession('ses_old', { title: 'OLIVE' })
      expect(await getSessionOpencodeFirstUserMessage('container', 'ses_gone')).toBeUndefined()
      // A workspace id, or no id, is not an opencode session.
      expect(await getSessionOpencodeFirstUserMessage('container', 'wt-1')).toBeUndefined()
      expect(await getSessionOpencodeFirstUserMessage('container')).toBeUndefined()
      // A malformed id is never passed to the command line.
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
