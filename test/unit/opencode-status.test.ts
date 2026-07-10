import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

vi.mock('@/lib/k8s/exec', () => ({
  containerExec: vi.fn(),
}))

import { containerExec } from '@/lib/k8s/exec'
import { opencodeMetaDir, opencodeMetaFile } from '@/shared/project-paths'
import {
  pickOpencodeSession,
  classifyOpencodePane,
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
  ensureOpencodeFirstMessageCaptured,
  _clearOpencodeProbeCacheForTests,
} from '@/lib/session/opencode-status'

const mockedExec = vi.mocked(containerExec)

/**
 * The HTTP probe (`curl /session`) goes through `containerExec`; the
 * helper installs a dispatching implementation so tests control it.
 * (Pane classification is watcher-fed now — `classifyOpencodePane` is
 * tested directly on strings.)
 */
function mockProbeResult(result: { stdout: string; stderr: string } | Error): void {
  mockedExec.mockImplementation((_jobName: string, cmd: string) => {
    if (cmd.includes('curl')) {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    }
    return Promise.reject(new Error('unexpected non-probe exec'))
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

    it('classifies the animated busy strip as running', () => {
      // Live opencode 1.17.11 footer: an 8-cell strip mixing ■ and ⬝,
      // then the interrupt hint. Either signal alone must be enough —
      // a narrow pane can truncate the hint away.
      expect(classifyOpencodePane('   ■■■■■⬝⬝⬝  esc interrupt\n')).toBe('running')
      expect(classifyOpencodePane('   ⬝⬝⬝⬝⬝⬝⬝⬝\n')).toBe('running')
      expect(classifyOpencodePane('   ■■■■\n')).toBe('running')
      expect(classifyOpencodePane('   ■⬝■⬝\n')).toBe('running')
    })

    it('does not treat short block runs as the busy strip', () => {
      // Bullets or box-drawing in transcript text can contain a few ■/⬝
      // cells; only a run of 4+ counts as the strip.
      expect(classifyOpencodePane('■ item one\n■ item two\n')).toBe('waiting')
      expect(classifyOpencodePane('■■■ almost\n')).toBe('waiting')
    })

    it('classifies an idle pane (no markers) as waiting', () => {
      expect(classifyOpencodePane('> _\nReady\n')).toBe('waiting')
    })

    it('classifies a permission dialog as waiting (busy footer is replaced)', () => {
      // Permission / question dialogs are footer panels: the status line
      // carrying the strip and interrupt hint only renders when no panel
      // is open, so a user-blocked pane carries neither signal.
      expect(classifyOpencodePane(
        '△ Permission required\n  ⚙ Call tool bash\n  enter allow\n',
      )).toBe('waiting')
    })

    it('classifies a question dialog as waiting', () => {
      expect(classifyOpencodePane(
        'Pick one:\n  > A\n    B\n  enter submit  esc dismiss\n',
      )).toBe('waiting')
    })

    it('matches the interrupt hint case-insensitively', () => {
      expect(classifyOpencodePane('ESC INTERRUPT\n')).toBe('running')
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
