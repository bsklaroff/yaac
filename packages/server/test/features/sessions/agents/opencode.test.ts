import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('#platform/k8s/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  sessionExec: vi.fn(),
}))

import { sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import {
  pickOpencodeSession,
  OPENCODE_BUSY_MARKERS,
  getSessionOpencodeFirstUserMessage,
  ensureOpencodeConfigJson,
} from '#features/sessions/agents/opencode'

const mockedExec = vi.mocked(sessionExec)

/**
 * The HTTP probe (`curl /session`) goes through `containerExec`; the
 * helper installs a dispatching implementation so tests control it.
 * (Busy/idle classification runs inside tmux now — the markers are pinned
 * here and validated end-to-end by verify-tmux-status-format.js.)
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
  beforeEach(() => {
    mockedExec.mockReset()
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
    it('returns the title of the container\'s session', async () => {
      mockProbeResult(sessionsStdout([{ id: 'ses_1', title: 'Refactor auth flow', updated: 1 }]))
      expect(await getSessionOpencodeFirstUserMessage('container')).toBe('Refactor auth flow')
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
