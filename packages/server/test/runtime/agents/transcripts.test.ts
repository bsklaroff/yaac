import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  setDataDir,
  claudeDir,
  codexDir,
  piDir,
  piSessionsDir,
} from '@yaac/shared/project-paths'
import {
  resolveProjectPath,
  piSessionLogs,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents/transcripts'

const slug = 'demo'

/** Host path of a claude transcript — the layout the module owns, spelled
 *  out here so the test would catch a change to it. */
function claudeLog(worktreeId: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace', `${worktreeId}.jsonl`)
}

/** The same log as the readers name it: under its tool's home. */
function claudeFile(worktreeId: string) {
  return { slug, dir: claudeDir(slug), rel: `projects/-workspace/${worktreeId}.jsonl` }
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

  describe('piSessionLogs', () => {
    it('returns only the logs whose filename carries the session id', async () => {
      await write(path.join(piSessionsDir(slug), '100_sess-1.jsonl'))
      await write(path.join(piSessionsDir(slug), '200_sess-1.jsonl'))
      await write(path.join(piSessionsDir(slug), 'workspace', '150_sess-1.jsonl'))
      await write(path.join(piSessionsDir(slug), '300_sess-2.jsonl'))
      // One level of subdirs, sorted by name, which is chronological.
      expect((await piSessionLogs(slug, 'sess-1')).map((f) => path.basename(f.rel)))
        .toEqual(['100_sess-1.jsonl', '150_sess-1.jsonl', '200_sess-1.jsonl'])
      expect(await piSessionLogs(slug, 'unknown')).toEqual([])
    })
  })

  describe('sessionTranscriptPath', () => {
    it('resolves claude by session id, once the file exists', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toBeUndefined()
      await write(claudeLog('sid'))
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toEqual(claudeFile('sid'))
    })

    it('finds a claude transcript filed under any cwd, but never through a link', async () => {
      await write(path.join(claudeDir(slug), 'projects', '-home-x', 'other.jsonl'))
      expect(await sessionTranscriptPath(slug, 'other', 'claude'))
        .toEqual({ slug, dir: claudeDir(slug), rel: 'projects/-home-x/other.jsonl' })
      // A link planted where a conversation would be names nothing.
      const elsewhere = await write(path.join(tmpDir, 'elsewhere.jsonl'))
      await fs.mkdir(path.dirname(claudeLog('linked')), { recursive: true })
      await fs.symlink(elsewhere, claudeLog('linked'))
      expect(await sessionTranscriptPath(slug, 'linked', 'claude')).toBeUndefined()
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
      await write(path.join(piSessionsDir(slug), '200_sid.jsonl'))
      expect(await sessionTranscriptPath(slug, 'sid', 'pi'))
        .toEqual({ slug, dir: piDir(slug), rel: 'agent/sessions/200_sid.jsonl' })
    })

    it('has none for opencode, which leaves no host transcript', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'opencode')).toBeUndefined()
    })
  })

  describe('transcriptLastActiveMs', () => {
    it('reports the mtime, and undefined once the file is gone', async () => {
      const file = await write(claudeLog('sid'))
      await fs.utimes(file, new Date('2026-01-02'), new Date('2026-01-02'))
      expect(await transcriptLastActiveMs(claudeFile('sid'))).toBe(Date.parse('2026-01-02'))

      await fs.rm(file)
      expect(await transcriptLastActiveMs(claudeFile('sid'))).toBeUndefined()
    })
  })

  describe('toProjectRelative', () => {
    it('strips the project directory, whatever tool wrote the path', () => {
      // One rule for every tool: the tool home is just the first segment.
      expect(toProjectRelative(claudeFile('sid')))
        .toBe(path.join('claude', 'projects', '-workspace', 'sid.jsonl'))
      expect(toProjectRelative({ slug, dir: codexDir(slug), rel: 'sessions/2026/rollout-x.jsonl' }))
        .toBe(path.join('codex', 'sessions', '2026', 'rollout-x.jsonl'))
    })

    it('refuses a path with no project-relative form', () => {
      expect(toProjectRelative({ slug, dir: '/tmp', rel: 'elsewhere.jsonl' })).toBeNull()
      // Another project's tree is just as much an escape.
      expect(toProjectRelative({ slug, dir: claudeDir('other'), rel: 't.jsonl' })).toBeNull()
    })
  })

  describe('resolveProjectPath', () => {
    it('resolves under the recording tool\'s own home, and round-trips the encoder', () => {
      const files = {
        claude: claudeFile('sid'),
        codex: { slug, dir: codexDir(slug), rel: 'sessions/rollout-x.jsonl' },
        pi: { slug, dir: piDir(slug), rel: 'agent/sessions/20260101-120000_sid.jsonl' },
      } as const
      for (const [tool, file] of Object.entries(files)) {
        const stored = toProjectRelative(file)
        expect(stored).not.toBeNull()
        expect(resolveProjectPath(slug, tool as keyof typeof files, stored ?? '')).toEqual(file)
      }
    })

    it('refuses what is not under that home: another tool\'s, the project\'s own files, a way out', () => {
      // A pane names its transcript, and anything in the workspace can set
      // the pane: a path to known_hosts or the clone's git config is not one.
      expect(resolveProjectPath(slug, 'claude', 'codex/sessions/r.jsonl')).toBeUndefined()
      expect(resolveProjectPath(slug, 'claude', 'known_hosts')).toBeUndefined()
      expect(resolveProjectPath(slug, 'claude', 'repo/.git/config')).toBeUndefined()
      expect(resolveProjectPath(slug, 'claude', 'claude/../../../etc/passwd')).toBeUndefined()
      expect(resolveProjectPath(slug, 'opencode', 'opencode-config/x.jsonl')).toBeUndefined()
      // The column holds project-relative values only.
      expect(resolveProjectPath(slug, 'claude', '/old/home/t.jsonl')).toBeUndefined()
    })
  })
})
