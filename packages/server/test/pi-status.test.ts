import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { setDataDir, piSessionsDir } from '@yaac/shared/project-paths'
import {
  classifyPiPane,
  getSessionPiFirstUserMessage,
  hasPiSessionLog,
  listPiSessionRecords,
} from '#lib/session/pi-status'

describe('classifyPiPane', () => {
  it('returns running when the pane shows an interrupt hint', () => {
    expect(classifyPiPane('… esc to interrupt')).toBe('running')
    expect(classifyPiPane('press esc to cancel')).toBe('running')
  })

  it('returns running when the pane shows a working indicator', () => {
    expect(classifyPiPane('Thinking…')).toBe('running')
    expect(classifyPiPane('Generating response')).toBe('running')
  })

  it('returns waiting for an idle prompt pane', () => {
    expect(classifyPiPane('> ')).toBe('waiting')
    expect(classifyPiPane('Ready. Type a message.')).toBe('waiting')
  })

  it('returns waiting for an empty pane', () => {
    expect(classifyPiPane('')).toBe('waiting')
  })
})

describe('pi first-message + session records', () => {
  const slug = 'proj'
  const sessionId = 'sess-1'
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-status-test-'))
    setDataDir(tmpDir)
    await fs.mkdir(piSessionsDir(slug, sessionId), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeLog(fileName: string, entries: Record<string, unknown>[]): Promise<void> {
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    return fs.writeFile(path.join(piSessionsDir(slug, sessionId), fileName), body)
  }

  it('returns the first user message (string content)', async () => {
    await writeLog('100_a.jsonl', [
      { type: 'session', id: 'x' },
      { type: 'message', message: { role: 'user', content: 'fix the login bug' } },
      { type: 'message', message: { role: 'assistant', content: 'on it' } },
    ])
    expect(await getSessionPiFirstUserMessage(slug, sessionId)).toBe('fix the login bug')
  })

  it('joins array text content parts', async () => {
    await writeLog('100_a.jsonl', [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      },
    ])
    expect(await getSessionPiFirstUserMessage(slug, sessionId)).toBe('hello world')
  })

  it('ignores assistant messages and non-message entries', async () => {
    await writeLog('100_a.jsonl', [
      { type: 'tool', name: 'bash' },
      { type: 'message', message: { role: 'assistant', content: 'thinking' } },
      { type: 'message', message: { role: 'user', content: 'the real prompt' } },
    ])
    expect(await getSessionPiFirstUserMessage(slug, sessionId)).toBe('the real prompt')
  })

  it('reads the oldest log first when several exist', async () => {
    // Filenames sort chronologically by their timestamp prefix.
    await writeLog('200_b.jsonl', [{ type: 'message', message: { role: 'user', content: 'newer' } }])
    await writeLog('100_a.jsonl', [{ type: 'message', message: { role: 'user', content: 'older' } }])
    expect(await getSessionPiFirstUserMessage(slug, sessionId)).toBe('older')
  })

  it('falls through to a later log when the first has no user message', async () => {
    await writeLog('100_a.jsonl', [{ type: 'message', message: { role: 'assistant', content: 'no user here' } }])
    await writeLog('200_b.jsonl', [{ type: 'message', message: { role: 'user', content: 'found me' } }])
    expect(await getSessionPiFirstUserMessage(slug, sessionId)).toBe('found me')
  })

  it('returns undefined when no logs exist', async () => {
    expect(await getSessionPiFirstUserMessage(slug, 'other-session')).toBeUndefined()
  })

  it('reports hasPiSessionLog by presence of a jsonl file', async () => {
    expect(await hasPiSessionLog(slug, sessionId)).toBe(false)
    await writeLog('100_a.jsonl', [{ type: 'message', message: { role: 'user', content: 'hi' } }])
    expect(await hasPiSessionLog(slug, sessionId)).toBe(true)
    expect(await hasPiSessionLog(slug, 'no-such-session')).toBe(false)
  })

  it('lists a record per session subdir that holds a log', async () => {
    await writeLog('100_a.jsonl', [{ type: 'message', message: { role: 'user', content: 'hi' } }])
    // An empty session dir (no jsonl) is not a record.
    await fs.mkdir(piSessionsDir(slug, 'empty-session'), { recursive: true })
    const records = await listPiSessionRecords(slug)
    expect(records.map((r) => r.sessionId)).toEqual([sessionId])
    expect(records[0].birthtimeMs).toBeGreaterThan(0)
    expect(records[0].lastActiveMs).toBeGreaterThan(0)
  })

  it('returns no records for a project with no pi sessions', async () => {
    expect(await listPiSessionRecords('empty-proj')).toEqual([])
  })
})
