import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { setDataDir, piSessionsDir } from '@yaac/shared/project-paths'
import {
  PI_BUSY_MARKERS,
  getSessionPiFirstUserMessage,
  hasPiSessionLog,
  listPiSessionRecords,
} from '#features/sessions/agents/pi-status'

describe('PI_BUSY_MARKERS', () => {
  it('pins the tmux-ERE busy markers the status format searches for', () => {
    // Encoded into a tmux content-search format by busyStatusFormat
    // (status-watcher.ts) and validated against a live tmux by
    // test-playwright-scripts/verify-tmux-status-format.js. The interrupt
    // hint covers "esc to interrupt" / "esc to cancel" / "esc to stop"; the
    // working hint covers thinking/working/generating/streaming/running.
    expect(PI_BUSY_MARKERS).toEqual([
      'esc\\s+(to\\s+)?(interrupt|cancel|stop)',
      '\\b(thinking|working|generating|streaming|running)\\b',
    ])
  })
})

describe('pi first-message + session records', () => {
  const slug = 'proj'
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-status-test-'))
    setDataDir(tmpDir)
    // All of a project's pi logs share one dir (mirroring ~/.claude); pi names
    // each `<timestamp>_<sessionId>.jsonl` and the server keys off that id.
    await fs.mkdir(piSessionsDir(slug), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // `ts` (the timestamp prefix) orders logs chronologically; `sessionId` is the
  // id pi embeds so the server can tell one session's logs from another's.
  function writeLog(ts: string, sessionId: string, entries: Record<string, unknown>[]): Promise<void> {
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    return fs.writeFile(path.join(piSessionsDir(slug), `${ts}_${sessionId}.jsonl`), body)
  }

  it('returns the first user message (string content)', async () => {
    await writeLog('100', 'sess-1', [
      { type: 'session', id: 'x' },
      { type: 'message', message: { role: 'user', content: 'fix the login bug' } },
      { type: 'message', message: { role: 'assistant', content: 'on it' } },
    ])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('fix the login bug')
  })

  it('joins array text content parts', async () => {
    await writeLog('100', 'sess-1', [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      },
    ])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('hello world')
  })

  it('ignores assistant messages and non-message entries', async () => {
    await writeLog('100', 'sess-1', [
      { type: 'tool', name: 'bash' },
      { type: 'message', message: { role: 'assistant', content: 'thinking' } },
      { type: 'message', message: { role: 'user', content: 'the real prompt' } },
    ])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('the real prompt')
  })

  it('reads the oldest log first when several exist', async () => {
    // Filenames sort chronologically by their timestamp prefix.
    await writeLog('200', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'newer' } }])
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'older' } }])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('older')
  })

  it('falls through to a later log when the first has no user message', async () => {
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'assistant', content: 'no user here' } }])
    await writeLog('200', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'found me' } }])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('found me')
  })

  it('reads only the requested session when the shared dir holds several', async () => {
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'from one' } }])
    await writeLog('100', 'sess-2', [{ type: 'message', message: { role: 'user', content: 'from two' } }])
    expect(await getSessionPiFirstUserMessage(slug, 'sess-1')).toBe('from one')
    expect(await getSessionPiFirstUserMessage(slug, 'sess-2')).toBe('from two')
  })

  it('returns undefined when no logs exist', async () => {
    expect(await getSessionPiFirstUserMessage(slug, 'other-session')).toBeUndefined()
  })

  it('reports hasPiSessionLog by presence of a matching jsonl file', async () => {
    expect(await hasPiSessionLog(slug, 'sess-1')).toBe(false)
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'hi' } }])
    expect(await hasPiSessionLog(slug, 'sess-1')).toBe(true)
    expect(await hasPiSessionLog(slug, 'no-such-session')).toBe(false)
  })

  it('lists a record per distinct session id in the shared dir', async () => {
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'hi' } }])
    await writeLog('150', 'sess-2', [{ type: 'message', message: { role: 'user', content: 'yo' } }])
    // A log without the `<ts>_<id>` separator has no session id, so no record.
    await fs.writeFile(path.join(piSessionsDir(slug), 'stray.jsonl'), '{}\n')
    const records = await listPiSessionRecords(slug)
    expect(records.map((r) => r.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
    for (const r of records) {
      expect(r.birthtimeMs).toBeGreaterThan(0)
      expect(r.lastActiveMs).toBeGreaterThan(0)
    }
  })

  it('merges multiple logs sharing a session id into one record', async () => {
    await writeLog('100', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'first' } }])
    await writeLog('200', 'sess-1', [{ type: 'message', message: { role: 'user', content: 'second' } }])
    const records = await listPiSessionRecords(slug)
    expect(records.map((r) => r.sessionId)).toEqual(['sess-1'])
  })

  it('returns no records for a project with no pi sessions', async () => {
    expect(await listPiSessionRecords('empty-proj')).toEqual([])
  })
})
