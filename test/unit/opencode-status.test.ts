import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

vi.mock('@/lib/k8s/exec', () => ({
  containerExec: vi.fn(),
}))

import { containerExec } from '@/lib/k8s/exec'
import { opencodeMetaDir, opencodeMetaFile } from '@/lib/project/paths'
import {
  pickOpencodeSession,
  classifyOpencodePane,
  getSessionOpencodeStatus,
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
  ensureOpencodeFirstMessageCaptured,
  _clearOpencodeProbeCacheForTests,
} from '@/lib/session/opencode-status'

const mockedExec = vi.mocked(containerExec)

/**
 * Both the HTTP probe (`curl /session`) and the tmux pane capture go
 * through `containerExec` now. Helpers below install a dispatching
 * implementation so each test can control the two paths independently.
 */
function mockProbeResult(result: { stdout: string; stderr: string } | Error): void {
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd.includes('curl')) {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    }
    return Promise.reject(new Error('unexpected non-probe exec'))
  })
}

function mockPaneResult(result: { stdout: string; stderr: string } | Error): void {
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd.includes('capture-pane')) {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    }
    return Promise.reject(new Error('unexpected non-pane exec'))
  })
}

function sessionsStdout(
  sessions: Array<{ id: string; title?: string; parentID?: string; updated?: number }>,
): { stdout: string; stderr: string } {
  const json = JSON.stringify(
    sessions.map((s) => ({
      id: s.id,
      title: s.title,
      directory: '/workspace',
      parentID: s.parentID,
      time: { created: 0, updated: s.updated ?? 0 },
    })),
  )
  return { stdout: json + '\n', stderr: '' }
}

function paneStdout(content: string): { stdout: string; stderr: string } {
  return { stdout: content, stderr: '' }
}

describe('opencode-status', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockedExec.mockReset()
    _clearOpencodeProbeCacheForTests()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('pickOpencodeSession', () => {
    it('picks the most-recently-updated root session', () => {
      const result = pickOpencodeSession({
        sessions: [
          { id: 's1', time: { created: 0, updated: 100 } },
          { id: 's2', time: { created: 0, updated: 500 } },
          { id: 's3', time: { created: 0, updated: 200 } },
        ],
      })
      expect(result?.id).toBe('s2')
    })

    it('prefers root sessions (no parentID) over forks', () => {
      const result = pickOpencodeSession({
        sessions: [
          { id: 'fork', parentID: 's-root', time: { created: 0, updated: 1000 } },
          { id: 's-root', time: { created: 0, updated: 100 } },
        ],
      })
      expect(result?.id).toBe('s-root')
    })

    it('falls back to any session if no roots are present', () => {
      const result = pickOpencodeSession({
        sessions: [
          { id: 'fork-a', parentID: 'missing', time: { created: 0, updated: 100 } },
          { id: 'fork-b', parentID: 'missing', time: { created: 0, updated: 500 } },
        ],
      })
      expect(result?.id).toBe('fork-b')
    })

    it('returns undefined for an empty session list', () => {
      const result = pickOpencodeSession({ sessions: [] })
      expect(result).toBeUndefined()
    })
  })

  describe('classifyOpencodePane', () => {
    it('classifies "esc interrupt" as running', () => {
      expect(classifyOpencodePane('Some output here\n  esc interrupt\n')).toBe('running')
    })

    it('classifies "esc again to interrupt" (after one ESC) as running', () => {
      expect(classifyOpencodePane('  esc again to interrupt\n')).toBe('running')
    })

    it('classifies an idle pane (no markers) as waiting', () => {
      expect(classifyOpencodePane('> _\nReady\n')).toBe('waiting')
    })

    it('classifies "Permission required" as waiting even with esc-interrupt visible', () => {
      // The permission overlay is rendered on top of the prompt area, so
      // the busy hint underneath can still be present in the pane.
      expect(classifyOpencodePane(
        '△ Permission required\n  ⚙ Call tool bash\n  esc interrupt\n',
      )).toBe('waiting')
    })

    it('classifies "esc dismiss" (question overlay) as waiting', () => {
      expect(classifyOpencodePane(
        '  enter submit  esc dismiss\n  esc interrupt\n',
      )).toBe('waiting')
    })

    it('matches the permission hint case-insensitively', () => {
      expect(classifyOpencodePane('PERMISSION REQUIRED\n')).toBe('waiting')
    })
  })

  describe('getSessionOpencodeStatus', () => {
    it('maps a pane with the interrupt hint to running', async () => {
      mockPaneResult(paneStdout('working...\n  esc interrupt\n'))
      const status = await getSessionOpencodeStatus('proj', 'sid', 'container')
      expect(status).toBe('running')
    })

    it('maps a pane with the permission overlay to waiting', async () => {
      mockPaneResult(paneStdout(
        '△ Permission required\n  $ rm -rf /\n  esc interrupt\n',
      ))
      const status = await getSessionOpencodeStatus('proj', 'sid', 'container')
      expect(status).toBe('waiting')
    })

    it('maps a pane with the question overlay to waiting', async () => {
      mockPaneResult(paneStdout(
        'Pick one:\n  > A\n    B\n  enter submit  esc dismiss\n',
      ))
      const status = await getSessionOpencodeStatus('proj', 'sid', 'container')
      expect(status).toBe('waiting')
    })

    it('maps an idle pane (no markers) to waiting', async () => {
      mockPaneResult(paneStdout('Ready.\n> _\n'))
      const status = await getSessionOpencodeStatus('proj', 'sid', 'container')
      expect(status).toBe('waiting')
    })

    it('returns waiting when capture-pane fails (container gone / tmux not up yet)', async () => {
      mockPaneResult(new Error('exec failed'))
      const status = await getSessionOpencodeStatus('proj', 'sid', 'container')
      expect(status).toBe('waiting')
    })

    it('coalesces concurrent probes into one capture-pane exec via the cache', async () => {
      mockPaneResult(paneStdout('  esc interrupt\n'))
      const [a, b, c] = await Promise.all([
        getSessionOpencodeStatus('proj', 'sid', 'container'),
        getSessionOpencodeStatus('proj', 'sid', 'container'),
        getSessionOpencodeStatus('proj', 'sid', 'container'),
      ])
      expect([a, b, c]).toEqual(['running', 'running', 'running'])
      expect(mockedExec).toHaveBeenCalledTimes(1)
    })
  })

  describe('getSessionOpencodeFirstUserMessage', () => {
    it('returns the title from the probe and caches it to the meta file', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      mockProbeResult(sessionsStdout(
        [{ id: 'ses_1', title: 'Refactor auth flow', updated: 1 }],
      ))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBe('Refactor auth flow')

      const cached = JSON.parse(
        await fs.readFile(opencodeMetaFile('proj', 'sid'), 'utf8'),
      ) as { firstMessage?: string; capturedAt?: string }
      expect(cached.firstMessage).toBe('Refactor auth flow')
      expect(typeof cached.capturedAt).toBe('string')
    })

    it('falls back to the cached meta file when the probe yields no session', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      await fs.writeFile(
        opencodeMetaFile('proj', 'sid'),
        JSON.stringify({ firstMessage: 'stale-but-useful', capturedAt: '2026-01-01' }),
      )
      mockProbeResult(sessionsStdout([]))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBe('stale-but-useful')
    })

    it('returns undefined when neither the probe nor the meta file have data', async () => {
      mockProbeResult(new Error('exec failed'))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBeUndefined()
    })
  })

  describe('getDeletedSessionOpencodeFirstUserMessage', () => {
    it('reads from the meta file without touching the pod', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      await fs.writeFile(
        opencodeMetaFile('proj', 'sid'),
        JSON.stringify({ firstMessage: 'cached title' }),
      )
      const msg = await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')
      expect(msg).toBe('cached title')
      expect(mockedExec).not.toHaveBeenCalled()
    })

    it('returns undefined when no meta file exists', async () => {
      const msg = await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')
      expect(msg).toBeUndefined()
    })
  })

  describe('ensureOpencodeFirstMessageCaptured', () => {
    it('skips the probe when a snapshot is already cached', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      await fs.writeFile(
        opencodeMetaFile('proj', 'sid'),
        JSON.stringify({ firstMessage: 'already cached' }),
      )
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      expect(mockedExec).not.toHaveBeenCalled()
    })

    it('probes and persists the title when no snapshot exists yet', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      mockProbeResult(sessionsStdout(
        [{ id: 'ses_1', title: 'Fix the parser', updated: 1 }],
      ))
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      const cached = JSON.parse(
        await fs.readFile(opencodeMetaFile('proj', 'sid'), 'utf8'),
      ) as { firstMessage?: string }
      expect(cached.firstMessage).toBe('Fix the parser')
    })

    it('persists nothing when the session has no title yet (no message submitted)', async () => {
      await fs.mkdir(opencodeMetaDir('proj'), { recursive: true })
      mockProbeResult(sessionsStdout([{ id: 'ses_1', updated: 1 }]))
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      await expect(fs.access(opencodeMetaFile('proj', 'sid'))).rejects.toBeTruthy()
    })
  })
})
