import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  setDataDir,
  claudeDir,
  codexDir,
  codexTranscriptDir,
  piSessionsDir,
} from '@yaac/shared/project-paths'
import {
  fromStoredTranscriptPath,
  listPiJsonlFiles,
  piSessionLogs,
  rehomeTranscriptPath,
  scanProjectTranscripts,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toStoredTranscriptPath,
  transcriptLastActiveMs,
} from '#features/sessions/transcripts'

const slug = 'demo'

/** Host path of a claude transcript — the layout the module owns, spelled
 *  out here so the test would catch a change to it. */
function claudeLog(sessionId: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace', `${sessionId}.jsonl`)
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
      // only a recorded path finds one — even with a legacy index entry that
      // happens to be named after the id sitting right there.
      await write(path.join(codexTranscriptDir(slug), 'sid.jsonl'))
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

  describe('scanProjectTranscripts', () => {
    it('finds every tool\'s sessions with their creation times', async () => {
      await write(claudeLog('cl-1'))
      await write(path.join(claudeDir(slug), 'projects', '-workspace', 'notes.txt'), 'x')
      await write(path.join(codexTranscriptDir(slug), 'cx-1.jsonl'))
      await write(path.join(piSessionsDir(slug), '100_pi-1.jsonl'))
      // Subagent transcripts live a directory deeper, so the scan never sees
      // them as sessions.
      await write(path.join(claudeDir(slug), 'projects', '-workspace', 'cl-1', 'subagents', 'agent-a.jsonl'))

      const records = await scanProjectTranscripts(slug)
      expect(records.map((r) => [r.sessionId, r.tool]).sort())
        .toEqual([['cl-1', 'claude'], ['cx-1', 'codex'], ['pi-1', 'pi']])
      for (const r of records) {
        expect(r.createdAtMs).toBeGreaterThan(0)
        expect(path.isAbsolute(r.transcriptPath)).toBe(true)
      }
    })

    it('returns [] for a project with no transcripts', async () => {
      expect(await scanProjectTranscripts('empty')).toEqual([])
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

  describe('toStoredTranscriptPath', () => {
    it('strips the tool home, per tool', async () => {
      expect(await toStoredTranscriptPath(slug, 'claude', claudeLog('sid')))
        .toBe(path.join('projects', '-workspace', 'sid.jsonl'))
      const rollout = path.join(codexDir(slug), 'sessions', '2026', 'rollout-x.jsonl')
      expect(await toStoredTranscriptPath(slug, 'codex', rollout))
        .toBe(path.join('sessions', '2026', 'rollout-x.jsonl'))
      const piLog = path.join(piSessionsDir(slug), '20260101-120000_sid.jsonl')
      expect(await toStoredTranscriptPath(slug, 'pi', piLog))
        .toBe(path.join('agent', 'sessions', '20260101-120000_sid.jsonl'))
    })

    it('refuses a path with no home-relative form', async () => {
      // Outside the home — the same verdict the in-pod hook reaches when it
      // writes an empty record.
      expect(await toStoredTranscriptPath(slug, 'claude', '/tmp/elsewhere.jsonl')).toBeNull()
      // Another project's home is just as much an escape.
      expect(await toStoredTranscriptPath(slug, 'claude', claudeDir('other'))).toBeNull()
      // opencode has no host home at all.
      expect(await toStoredTranscriptPath(slug, 'opencode', '/anything.jsonl')).toBeNull()
    })

    it('relativizes a path that resolved through a symlinked data dir', async () => {
      // The legacy-symlink branch of readWorktreeLinks hands back realpath
      // output, so on a data dir with a symlinked component the literal home
      // is not a textual prefix of it.
      const real = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-real-'))
      const link = path.join(tmpDir, 'linked-data')
      await fs.symlink(real, link)
      setDataDir(link)
      try {
        await fs.mkdir(claudeDir(slug), { recursive: true })
        const viaReal = path.join(await fs.realpath(claudeDir(slug)), 'projects', 'x.jsonl')
        expect(await toStoredTranscriptPath(slug, 'claude', viaReal))
          .toBe(path.join('projects', 'x.jsonl'))
      } finally {
        setDataDir(tmpDir)
        await fs.rm(real, { recursive: true, force: true })
      }
    })
  })

  describe('fromStoredTranscriptPath', () => {
    it('rejoins the tool home', () => {
      expect(fromStoredTranscriptPath(slug, 'claude', path.join('projects', 'a.jsonl')))
        .toBe(path.join(claudeDir(slug), 'projects', 'a.jsonl'))
    })

    it('round-trips what toStoredTranscriptPath produced', async () => {
      const abs = claudeLog('sid')
      const stored = await toStoredTranscriptPath(slug, 'claude', abs)
      expect(stored).not.toBeNull()
      expect(fromStoredTranscriptPath(slug, 'claude', stored ?? '')).toBe(abs)
    })

    it('passes an absolute value straight through', () => {
      // A row the relativize sweep has not reached; joining it onto the home
      // would fabricate a path that resolves nowhere.
      expect(fromStoredTranscriptPath(slug, 'claude', '/old/home/t.jsonl'))
        .toBe('/old/home/t.jsonl')
    })

    it('refuses a stored value that climbs out of the home', () => {
      // The encoder can never emit this; the guard keeps the pair symmetric
      // in what it refuses, whatever else ever writes the column.
      expect(fromStoredTranscriptPath(slug, 'claude', '../../../../etc/passwd'))
        .toBeUndefined()
      expect(fromStoredTranscriptPath(slug, 'claude', 'projects/../../../etc/passwd'))
        .toBeUndefined()
    })
  })

  describe('rehomeTranscriptPath', () => {
    it('recovers the tail from a path another data dir wrote', () => {
      // The restored-backup case: the old root is gone, but every home is
      // <root>/projects/<slug>/<tool>, so the boundary is enough.
      const old = `/old/box/.yaac/projects/${slug}/claude/projects/-workspace/c.jsonl`
      expect(rehomeTranscriptPath(slug, 'claude', old))
        .toBe(path.join('projects', '-workspace', 'c.jsonl'))
    })

    it('takes the innermost home when a nested yaac repeats the marker', () => {
      const nested = `/old/.yaac/projects/${slug}/sessions/s1/nested-yaac`
        + `/projects/${slug}/claude/projects/-workspace/c.jsonl`
      expect(rehomeTranscriptPath(slug, 'claude', nested))
        .toBe(path.join('projects', '-workspace', 'c.jsonl'))
    })

    it('gives up when the marker is absent or the tool has no home', () => {
      expect(rehomeTranscriptPath(slug, 'claude', '/somewhere/else/c.jsonl')).toBeNull()
      // Another project's home is not this row's.
      expect(rehomeTranscriptPath(slug, 'claude', '/old/projects/other/claude/x.jsonl'))
        .toBeNull()
      expect(rehomeTranscriptPath(slug, 'opencode', `/old/projects/${slug}/opencode/x`))
        .toBeNull()
    })
  })
})
