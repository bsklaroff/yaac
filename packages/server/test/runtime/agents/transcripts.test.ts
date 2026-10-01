import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  setDataDir,
  agentHistoryDir,
  claudeDir,
  codexDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  claudeProjectDirName,
  locateTranscript,
  resolveProjectPath,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents/transcripts'

const slug = 'demo'
const wt = 'wt-a'

/** Host path of a claude transcript, written out so a layout change fails. */
function claudeLog(workspaceId: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace', `${workspaceId}.jsonl`)
}

/** The same log, relative to the tool's home. */
function claudeFile(workspaceId: string) {
  return { slug, dir: claudeDir(slug), rel: `projects/-workspace/${workspaceId}.jsonl` }
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

  describe('claudeProjectDirName', () => {
    it('punches every non-alphanumeric out of the cwd', () => {
      expect(claudeProjectDirName('/workspace')).toBe('-workspace')
      expect(claudeProjectDirName('/home/me/.yaac/projects/p_1/workspaces/abc'))
        .toBe('-home-me--yaac-projects-p-1-workspaces-abc')
    })

    it('cuts a long one at 200 and appends claude\'s own hash of the whole path', () => {
      // Observed from claude 2.1.282 run in this cwd.
      const cwd = `/tmp/claude-1000/-workspace/26a9c9fd-de5b-4db5-a741-c3522285d032/scratchpad/cc/${'a'.repeat(120)}/with.dots_and space/${'b'.repeat(100)}`
      expect(claudeProjectDirName(cwd)).toBe(
        `-tmp-claude-1000--workspace-26a9c9fd-de5b-4db5-a741-c3522285d032-scratchpad-cc-${'a'.repeat(120)}--yck5ws`,
      )
    })
  })

  describe('sessionTranscriptPath', () => {
    it('resolves claude by session id, once the file exists', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toBeUndefined()
      await write(claudeLog('sid'))
      expect(await sessionTranscriptPath(slug, 'sid', 'claude')).toEqual(claudeFile('sid'))
    })

    it('looks in the workspace\'s own history first, and only its own', async () => {
      const own = path.join(agentHistoryDir(slug, wt, 'claude'), '-workspace', 'conv.jsonl')
      await write(own)
      await write(path.join(claudeDir(slug), 'projects', '-workspace', 'conv.jsonl'))
      await write(path.join(agentHistoryDir(slug, 'wt-b', 'claude'), '-workspace', 'theirs.jsonl'))
      expect(await sessionTranscriptPath(slug, wt, 'claude', 'conv'))
        .toEqual({ slug, dir: agentHistoryDir(slug, wt, 'claude'), rel: '-workspace/conv.jsonl' })
      // Other workspaces' history is never searched.
      expect(await sessionTranscriptPath(slug, wt, 'claude', 'theirs')).toBeUndefined()
    })

    it('finds a claude transcript filed under any cwd, but never through a link', async () => {
      await write(path.join(claudeDir(slug), 'projects', '-home-x', 'other.jsonl'))
      expect(await sessionTranscriptPath(slug, 'other', 'claude'))
        .toEqual({ slug, dir: claudeDir(slug), rel: 'projects/-home-x/other.jsonl' })
      // A symlink in place of a conversation is ignored.
      const elsewhere = await write(path.join(tmpDir, 'elsewhere.jsonl'))
      await fs.mkdir(path.dirname(claudeLog('linked')), { recursive: true })
      await fs.symlink(elsewhere, claudeLog('linked'))
      expect(await sessionTranscriptPath(slug, 'linked', 'claude')).toBeUndefined()
    })

    it('has none for codex, whose rollout name follows from no id', async () => {
      // A codex rollout's filename cannot be derived from its id, so only a
      // recorded path finds it.
      await write(path.join(codexDir(slug), 'sessions', 'sid.jsonl'))
      expect(await sessionTranscriptPath(slug, 'sid', 'codex')).toBeUndefined()
    })

    it('picks pi\'s newest log for the id from the history, one folder down too', async () => {
      const dir = agentHistoryDir(slug, wt, 'pi')
      await write(path.join(dir, '100_sid.jsonl'))
      await write(path.join(dir, 'workspace', '150_sid.jsonl'))
      await write(path.join(dir, '300_other.jsonl'))
      expect(await sessionTranscriptPath(slug, wt, 'pi', 'sid'))
        .toEqual({ slug, dir, rel: 'workspace/150_sid.jsonl' })
      expect(await sessionTranscriptPath(slug, wt, 'pi', 'unknown')).toBeUndefined()
    })

    it('has none for opencode, which leaves no host transcript', async () => {
      expect(await sessionTranscriptPath(slug, 'sid', 'opencode')).toBeUndefined()
    })
  })

  describe('locateTranscript', () => {
    const reported = 'claude/projects/-workspace/conv.jsonl'

    it('maps a reported path into the workspace\'s history first, then the shared home', async () => {
      // Not written yet; a later pass will find it.
      expect(await locateTranscript(slug, wt, 'claude', 'conv', reported)).toBeUndefined()
      await write(path.join(projectDir(slug), reported))
      expect(await locateTranscript(slug, wt, 'claude', 'conv', reported)).toBe(reported)
      await write(path.join(agentHistoryDir(slug, wt, 'claude'), '-workspace', 'conv.jsonl'))
      expect(await locateTranscript(slug, wt, 'claude', 'conv', reported))
        .toBe(path.join('history', wt, 'claude', '-workspace', 'conv.jsonl'))
      await write(path.join(agentHistoryDir(slug, wt, 'codex'), '2026', 'rollout-x.jsonl'))
      expect(await locateTranscript(slug, wt, 'codex', 'x', 'codex/sessions/2026/rollout-x.jsonl'))
        .toBe(path.join('history', wt, 'codex', '2026', 'rollout-x.jsonl'))
    })

    it('names the file a host link leads to, and refuses one leading to a sibling', async () => {
      // On a host, history is reached through a directory symlink.
      const history = path.join(agentHistoryDir(slug, wt, 'claude'), '-workspace')
      await write(path.join(history, 'host.jsonl'))
      await fs.mkdir(path.join(claudeDir(slug), 'projects'), { recursive: true })
      await fs.symlink(history, path.join(claudeDir(slug), 'projects', '-host-checkout'))
      expect(await locateTranscript(slug, wt, 'claude', 'host', 'claude/projects/-host-checkout/host.jsonl'))
        .toBe(path.join('history', wt, 'claude', '-workspace', 'host.jsonl'))

      const sibling = path.join(agentHistoryDir(slug, 'wt-b', 'claude'), '-workspace')
      await write(path.join(sibling, 'theirs.jsonl'))
      await fs.symlink(sibling, path.join(claudeDir(slug), 'projects', '-sibling'))
      expect(await locateTranscript(slug, wt, 'claude', 'theirs', 'claude/projects/-sibling/theirs.jsonl'))
        .toBeUndefined()
      await fs.symlink(path.join(projectDir(slug), 'known_hosts'), path.join(history, 'kh.jsonl'))
      await write(path.join(projectDir(slug), 'known_hosts'))
      expect(await locateTranscript(slug, wt, 'claude', 'kh', 'claude/projects/-workspace/kh.jsonl'))
        .toBeUndefined()
    })

    it('drops any prefix the reporter never emits, and finds pi by id', async () => {
      await write(path.join(projectDir(slug), 'claude', 'settings.json'))
      expect(await locateTranscript(slug, wt, 'claude', 'x', 'claude/settings.json')).toBeUndefined()
      expect(await locateTranscript(slug, wt, 'claude', 'x', undefined)).toBeUndefined()
      await write(path.join(agentHistoryDir(slug, wt, 'pi'), '100_psid.jsonl'))
      expect(await locateTranscript(slug, wt, 'pi', 'psid', undefined))
        .toBe(path.join('history', wt, 'pi', '100_psid.jsonl'))
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
      expect(toProjectRelative(claudeFile('sid')))
        .toBe(path.join('claude', 'projects', '-workspace', 'sid.jsonl'))
      expect(toProjectRelative({ slug, dir: codexDir(slug), rel: 'sessions/2026/rollout-x.jsonl' }))
        .toBe(path.join('codex', 'sessions', '2026', 'rollout-x.jsonl'))
    })

    it('refuses a path with no project-relative form', () => {
      expect(toProjectRelative({ slug, dir: '/tmp', rel: 'elsewhere.jsonl' })).toBeNull()
      expect(toProjectRelative({ slug, dir: claudeDir('other'), rel: 't.jsonl' })).toBeNull()
    })
  })

  describe('resolveProjectPath', () => {
    it('resolves under the recording tool\'s home or its part of this workspace\'s history', () => {
      const files = {
        claude: claudeFile('sid'),
        codex: { slug, dir: codexDir(slug), rel: 'sessions/rollout-x.jsonl' },
        pi: { slug, dir: agentHistoryDir(slug, wt, 'pi'), rel: '20260101-120000_sid.jsonl' },
      } as const
      for (const [tool, file] of Object.entries(files)) {
        const stored = toProjectRelative(file)
        expect(stored).not.toBeNull()
        expect(resolveProjectPath(slug, wt, tool as keyof typeof files, stored ?? '')).toEqual(file)
      }
      expect(resolveProjectPath(slug, wt, 'claude', `history/${wt}/claude/-workspace/sid.jsonl`))
        .toEqual({ slug, dir: agentHistoryDir(slug, wt, 'claude'), rel: '-workspace/sid.jsonl' })
    })

    it('refuses what is not under those: another tool\'s, a sibling\'s, the project\'s own files, a way out', () => {
      // The workspace controls this value, so it must not reach arbitrary
      // project files.
      expect(resolveProjectPath(slug, wt, 'claude', 'codex/sessions/r.jsonl')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'claude', `history/${wt}/codex/r.jsonl`)).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'claude', 'history/wt-b/claude/-workspace/t.jsonl')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'claude', 'known_hosts')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'claude', 'repo/.git/config')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'claude', 'claude/../../../etc/passwd')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'opencode', 'opencode-config/x.jsonl')).toBeUndefined()
      expect(resolveProjectPath(slug, wt, 'pi', 'pi/agent/sessions/x.jsonl')).toBeUndefined()
      // Only project-relative values are accepted.
      expect(resolveProjectPath(slug, wt, 'claude', '/old/home/t.jsonl')).toBeUndefined()
    })
  })
})
