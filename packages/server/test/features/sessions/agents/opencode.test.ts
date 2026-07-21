import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#platform/k8s/exec', () => ({
  containerExec: vi.fn(),
}))

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
  }
})

import { containerExec } from '#platform/k8s/exec'
import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { getDb, closeDb } from '#platform/db/client'
import { opencodeSessionMeta } from '#platform/db/schema'
import {
  pickOpencodeSession,
  classifyOpencodePane,
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
  ensureOpencodeFirstMessageCaptured,
  captureOpencodeFirstMessages,
  saveOpencodeMeta,
  hasOpencodeMeta,
  listOpencodeMetaEntries,
  ensureOpencodeConfigJson,
  _clearOpencodeProbeCacheForTests,
} from '#features/sessions/agents/opencode'

const mockedExec = vi.mocked(containerExec)
const mockListPods = vi.mocked(listSessionPods)

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

  // One PGlite per file: cold-init is the expensive part, so the tests
  // share a data dir and wipe the meta table instead of recreating it.
  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    mockedExec.mockReset()
    _clearOpencodeProbeCacheForTests()
    const db = await getDb()
    await db.delete(opencodeSessionMeta)
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

  describe('meta snapshots (saveOpencodeMeta / hasOpencodeMeta / listOpencodeMetaEntries)', () => {
    it('round-trips a snapshot and upserts in place, preserving createdAt', async () => {
      expect(await hasOpencodeMeta('proj', 'sid')).toBe(false)
      await saveOpencodeMeta('proj', 'sid', { firstMessage: 'one', capturedAt: '2026-01-01' })
      expect(await hasOpencodeMeta('proj', 'sid')).toBe(true)
      const [first] = await listOpencodeMetaEntries('proj')
      expect(first.sessionId).toBe('sid')
      expect(first.createdAt).toBeInstanceOf(Date)

      await saveOpencodeMeta('proj', 'sid', { firstMessage: 'two', capturedAt: '2026-01-02' })
      const entries = await listOpencodeMetaEntries('proj')
      expect(entries).toHaveLength(1)
      expect(entries[0].createdAt.getTime()).toBe(first.createdAt.getTime())
      expect(await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')).toBe('two')
    })

    it('listOpencodeMetaEntries filters by project', async () => {
      await saveOpencodeMeta('a', 's1', { firstMessage: 'x' })
      await saveOpencodeMeta('b', 's2', { firstMessage: 'y' })
      expect((await listOpencodeMetaEntries('a')).map((e) => e.sessionId)).toEqual(['s1'])
    })
  })

  describe('getSessionOpencodeFirstUserMessage', () => {
    it('returns the title from the probe and caches it as a snapshot', async () => {
      mockProbeResult(sessionsStdout(
        [{ id: 'ses_1', title: 'Refactor auth flow', updated: 1 }],
      ))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBe('Refactor auth flow')

      expect(await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')).toBe('Refactor auth flow')
      const db = await getDb()
      const [row] = await db.select().from(opencodeSessionMeta)
      expect(typeof row.capturedAt).toBe('string')
    })

    it('falls back to the cached snapshot when the probe yields no session', async () => {
      await saveOpencodeMeta('proj', 'sid', { firstMessage: 'stale-but-useful', capturedAt: '2026-01-01' })
      mockProbeResult(sessionsStdout([]))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBe('stale-but-useful')
    })

    it('returns undefined when neither the probe nor the snapshot have data', async () => {
      mockProbeResult(new Error('exec failed'))
      const msg = await getSessionOpencodeFirstUserMessage('proj', 'sid', 'container')
      expect(msg).toBeUndefined()
    })
  })

  describe('getDeletedSessionOpencodeFirstUserMessage', () => {
    it('reads from the snapshot without touching the pod', async () => {
      await saveOpencodeMeta('proj', 'sid', { firstMessage: 'cached title' })
      const msg = await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')
      expect(msg).toBe('cached title')
      expect(mockedExec).not.toHaveBeenCalled()
    })

    it('returns undefined when no snapshot exists', async () => {
      const msg = await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')
      expect(msg).toBeUndefined()
    })
  })

  describe('ensureOpencodeFirstMessageCaptured', () => {
    it('skips the probe when a snapshot is already cached', async () => {
      await saveOpencodeMeta('proj', 'sid', { firstMessage: 'already cached' })
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      expect(mockedExec).not.toHaveBeenCalled()
    })

    it('probes and persists the title when no snapshot exists yet', async () => {
      mockProbeResult(sessionsStdout(
        [{ id: 'ses_1', title: 'Fix the parser', updated: 1 }],
      ))
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      expect(await getDeletedSessionOpencodeFirstUserMessage('proj', 'sid')).toBe('Fix the parser')
    })

    it('persists nothing when the session has no title yet (no message submitted)', async () => {
      mockProbeResult(sessionsStdout([{ id: 'ses_1', updated: 1 }]))
      await ensureOpencodeFirstMessageCaptured('proj', 'sid', 'container')
      expect(await hasOpencodeMeta('proj', 'sid')).toBe(false)
    })
  })
})

describe('captureOpencodeFirstMessages', () => {
  let tmpDir: string

  function pod(overrides: { sessionId: string; tool: string }): SessionPod {
    return {
      jobName: `yaac-demo-${overrides.sessionId}`,
      podName: `yaac-demo-${overrides.sessionId}-x1`,
      sessionId: overrides.sessionId,
      projectSlug: 'demo',
      tool: overrides.tool,
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 0,
      labels: {},
    }
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockedExec.mockReset()
    _clearOpencodeProbeCacheForTests()
    mockListPods.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('captures only running opencode sessions, skipping other tools', async () => {
    mockListPods.mockResolvedValue([
      pod({ sessionId: 'ocsess', tool: 'opencode' }),
      pod({ sessionId: 'clsess', tool: 'claude' }),
    ])
    // Probe returns no session — the capture path still runs the curl exec
    // for the opencode pod, which is the observable we assert on. Only the
    // opencode session is probed; the claude session is filtered out before
    // any exec (containerExec is used solely for the `/session` probe).
    mockProbeResult(sessionsStdout([]))

    await captureOpencodeFirstMessages()

    expect(mockedExec.mock.calls.map((c) => c[0])).toEqual(['yaac-demo-ocsess'])
  })

  it('returns early without capturing when the cluster is unavailable', async () => {
    mockListPods.mockRejectedValue(new Error('down'))

    await expect(captureOpencodeFirstMessages()).resolves.toBeUndefined()
    expect(mockedExec).not.toHaveBeenCalled()
  })
})

interface OpencodeConfig {
  permission?: Record<string, unknown>
  [key: string]: unknown
}

describe('ensureOpencodeConfigJson', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates opencode.json from scratch when none exists', async () => {
    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('preserves existing top-level keys and adds the permission', async () => {
    const existing: OpencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-5',
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.$schema).toBe('https://opencode.ai/config.json')
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5')
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('preserves existing sibling permissions', async () => {
    const existing: OpencodeConfig = {
      permission: { edit: 'ask' },
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.permission?.edit).toBe('ask')
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('does not rewrite when websearch is already allowed', async () => {
    await ensureOpencodeConfigJson(tmpDir)
    const beforeStat = await fs.stat(path.join(tmpDir, 'opencode.json'))
    await new Promise((r) => setTimeout(r, 50))
    await ensureOpencodeConfigJson(tmpDir)
    const afterStat = await fs.stat(path.join(tmpDir, 'opencode.json'))
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })

  it('overwrites a non-allow websearch permission', async () => {
    const existing: OpencodeConfig = {
      permission: { websearch: 'ask' },
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('handles invalid existing opencode.json gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'opencode.json'), 'not valid json')
    await ensureOpencodeConfigJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('handles a non-object existing opencode.json gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'opencode.json'), '[]')
    await ensureOpencodeConfigJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })
})
