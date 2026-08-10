import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  setDataDir,
  claudeDir,
  codexDir,
  piSessionsDir,
} from '@yaac/shared/project-paths'
import {
  resolveProjectPath,
  listPiJsonlFiles,
  piSessionLogs,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#store/transcripts/transcripts'

const slug = 'demo'

/** Host path of a claude transcript — the layout the module owns, spelled
 *  out here so the test would catch a change to it. */
function claudeLog(worktreeId: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace', `${worktreeId}.jsonl`)
}

async function write(file: string, body = '{}\n'): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
  return file
}

describe('transcripts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-transcripts-'))
    setDataDir(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('sessionIdFromPiLog', () => {
    it('takes everything after the timestamp prefix', () => {
      expect(sessionIdFromPiLog('/logs/20260101-120000_sess-1.jsonl')).toBe('sess-1')
    })

    it('returns undefined without a separator, or with an empty id', () => {
      expect(sessionIdFromPiLog('/logs/stray.jsonl')).toBeUndefined()
      expect(sessionIdFromPiLog('/logs/100_.jsonl')).toBeUndefined()
    })
  })

  describe('listPiJsonlFiles', () => {
    it('walks one level of subdirs and sorts by basename', async () => {
      const dir = piSessionsDir(slug)
      await write(path.join(dir, '200_b.jsonl'))
      await write(path.join(dir, '100_a.jsonl'))
      await write(path.join(dir, 'workspace', '150_c.jsonl'))
      await write(path.join(dir, 'notes.txt'), 'x')
      expect((await listPiJsonlFiles(dir)).map((f) => path.basename(f)))
        .toEqual(['100_a.jsonl', '150_c.jsonl', '200_b.jsonl'])
    })

    it('returns [] for a missing dir', async () => {
      expect(await listPiJsonlFiles(path.join(tmpDir, 'nope'))).toEqual([])
    })
  })

  describe('piSessionLogs', () => {
    it('returns only the logs whose filename carries the session id', async () => {
      await write(path.join(piSessionsDir(slug), '100_sess-1.jsonl'))
      await write(path.join(piSessionsDir(slug), '200_sess-1.jsonl'))
      await write(path.join(piSessionsDir(slug), '300_sess-2.jsonl'))
      expect((await piSessionLogs(slug, 'sess-1')).map((f) => path.basename(f)))
        .toEqual(['100_sess-1.jsonl', '200_sess-1.jsonl'])
      expect(await piSessionLogs(slug, 'unknown')).toEqual([])
    })
  })

  describe('sessionTranscriptPath', () => {
    it('resolves claude by session id, once the file exists', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toBeUndefined()
      const claude = await write(claudeLog('sid'))
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toBe(claude)
    })

    it('has none for codex, whose rollout name follows from no id', async () => {
      // Nothing derives a codex rollout filename from a conversation id, so
      // only a recorded path finds one — even for a file sitting in codex's
      // own home named after the id.
      await write(path.join(codexDir(slug), 'sessions', 'sid.jsonl'))
      expect(await sessionTranscriptPath(slug, 'sid', 'codex')).toBeUndefined()
    })

    it('picks pi\'s newest log, since pi names the file itself', async () => {
      await write(path.join(piSessionsDir(slug), '100_sid.jsonl'))
      const newest = await write(path.join(piSessionsDir(slug), '200_sid.jsonl'))
      expect(await sessionTranscriptPath(slug, 'sid', 'pi')).toBe(newest)
    })

    it('has none for opencode, which leaves no host transcript', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'opencode')).toBeUndefined()
    })
  })

  describe('transcriptLastActiveMs', () => {
    it('reports the mtime, and undefined once the file is gone', async () => {
      const file = await write(claudeLog('sid'))
      await fs.utimes(file, new Date('2026-01-02'), new Date('2026-01-02'))
      expect(await transcriptLastActiveMs(file)).toBe(Date.parse('2026-01-02'))

      await fs.rm(file)
      expect(await transcriptLastActiveMs(file)).toBeUndefined()
    })
  })

  describe('toProjectRelative', () => {
    it('strips the project directory, whatever tool wrote the path', () => {
      // One rule for every tool: the tool home is just the first segment.
      expect(toProjectRelative(slug, claudeLog('sid')))
        .toBe(path.join('claude', 'projects', '-workspace', 'sid.jsonl'))
      const rollout = path.join(codexDir(slug), 'sessions', '2026', 'rollout-x.jsonl')
      expect(toProjectRelative(slug, rollout))
        .toBe(path.join('codex', 'sessions', '2026', 'rollout-x.jsonl'))
      const piLog = path.join(piSessionsDir(slug), '20260101-120000_sid.jsonl')
      expect(toProjectRelative(slug, piLog))
        .toBe(path.join('pi', 'agent', 'sessions', '20260101-120000_sid.jsonl'))
    })

    it('refuses a path with no project-relative form', () => {
      // Outside the project tree — the same verdict the in-pod hook reaches
      // when it writes an empty record.
      expect(toProjectRelative(slug, '/tmp/elsewhere.jsonl')).toBeNull()
      // Another project's tree is just as much an escape.
      expect(toProjectRelative(slug, claudeDir('other'))).toBeNull()
    })
  })

  describe('resolveProjectPath', () => {
    it('rejoins the project directory', () => {
      expect(resolveProjectPath(slug, path.join('claude', 'projects', 'a.jsonl')))
        .toBe(path.join(claudeDir(slug), 'projects', 'a.jsonl'))
    })

    it('round-trips what toProjectRelative produced, for every tool', () => {
      for (const abs of [
        claudeLog('sid'),
        path.join(codexDir(slug), 'sessions', 'rollout-x.jsonl'),
        path.join(piSessionsDir(slug), '20260101-120000_sid.jsonl'),
      ]) {
        const stored = toProjectRelative(slug, abs)
        expect(stored).not.toBeNull()
        expect(resolveProjectPath(slug, stored ?? '')).toBe(abs)
      }
    })

    it('refuses an absolute value', () => {
      // The column holds project-relative values only; joining an absolute
      // onto the project dir would fabricate a path that resolves nowhere.
      expect(resolveProjectPath(slug, '/old/home/t.jsonl')).toBeUndefined()
    })

    it('refuses a stored value that climbs out of the project directory', () => {
      // The encoder can never emit this; the guard keeps the pair symmetric
      // in what it refuses, whatever else ever writes the column.
      expect(resolveProjectPath(slug, '../../../../etc/passwd')).toBeUndefined()
      expect(resolveProjectPath(slug, 'claude/../../../etc/passwd')).toBeUndefined()
    })
  })
})
