import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import {
  setDataDir,
  acpLogDir,
  agentHistoryDir,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  claudeProjectDirName,
  conversationFiles,
  locateTranscript,
  openConversationFile,
  resolveProjectPath,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents/transcripts'

const projectId = 'demo'
const wt = 'wt-a'

/** Host path of a claude transcript, written out so a layout change fails. */
function claudeLog(workspaceId: string): string {
  return path.join(claudeDir(projectId), 'projects', '-workspace', `${workspaceId}.jsonl`)
}

/** The same log, relative to the tool's home. */
function claudeFile(workspaceId: string) {
  return { projectId, dir: claudeDir(projectId), rel: `projects/-workspace/${workspaceId}.jsonl` }
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
      expect(await sessionTranscriptPath(projectId, 'sid', 'claude')).toBeUndefined()
      await write(claudeLog('sid'))
      expect(await sessionTranscriptPath(projectId, 'sid', 'claude')).toEqual(claudeFile('sid'))
    })

    it('looks in the workspace\'s own history first, and only its own', async () => {
      const own = path.join(agentHistoryDir(projectId, wt, 'claude'), '-workspace', 'conv.jsonl')
      await write(own)
      await write(path.join(claudeDir(projectId), 'projects', '-workspace', 'conv.jsonl'))
      await write(path.join(agentHistoryDir(projectId, 'wt-b', 'claude'), '-workspace', 'theirs.jsonl'))
      expect(await sessionTranscriptPath(projectId, wt, 'claude', 'conv'))
        .toEqual({ projectId, dir: agentHistoryDir(projectId, wt, 'claude'), rel: '-workspace/conv.jsonl' })
      // Other workspaces' history is never searched.
      expect(await sessionTranscriptPath(projectId, wt, 'claude', 'theirs')).toBeUndefined()
    })

    it('finds a claude transcript filed under any cwd, but never through a link', async () => {
      await write(path.join(claudeDir(projectId), 'projects', '-home-x', 'other.jsonl'))
      expect(await sessionTranscriptPath(projectId, 'other', 'claude'))
        .toEqual({ projectId, dir: claudeDir(projectId), rel: 'projects/-home-x/other.jsonl' })
      // A symlink in place of a conversation is ignored.
      const elsewhere = await write(path.join(tmpDir, 'elsewhere.jsonl'))
      await fs.mkdir(path.dirname(claudeLog('linked')), { recursive: true })
      await fs.symlink(elsewhere, claudeLog('linked'))
      expect(await sessionTranscriptPath(projectId, 'linked', 'claude')).toBeUndefined()
    })

    it('has none for codex, whose rollout name follows from no id', async () => {
      // A codex rollout's filename cannot be derived from its id, so only a
      // recorded path finds it.
      await write(path.join(codexDir(projectId), 'sessions', 'sid.jsonl'))
      expect(await sessionTranscriptPath(projectId, 'sid', 'codex')).toBeUndefined()
    })

    it('picks pi\'s newest log for the id from the history, one folder down too', async () => {
      const dir = agentHistoryDir(projectId, wt, 'pi')
      await write(path.join(dir, '100_sid.jsonl'))
      await write(path.join(dir, 'workspace', '150_sid.jsonl'))
      await write(path.join(dir, '300_other.jsonl'))
      expect(await sessionTranscriptPath(projectId, wt, 'pi', 'sid'))
        .toEqual({ projectId, dir, rel: 'workspace/150_sid.jsonl' })
      expect(await sessionTranscriptPath(projectId, wt, 'pi', 'unknown')).toBeUndefined()
    })

    it('has none for opencode, which leaves no host transcript', async () => {
      expect(await sessionTranscriptPath(projectId, 'sid', 'opencode')).toBeUndefined()
    })
  })

  describe('locateTranscript', () => {
    const reported = 'claude/projects/-workspace/conv.jsonl'

    it('maps a reported path into the workspace\'s history first, then the shared home', async () => {
      // Not written yet; a later pass will find it.
      expect(await locateTranscript(projectId, wt, 'claude', 'conv', reported)).toBeUndefined()
      await write(path.join(projectDir(projectId), reported))
      expect(await locateTranscript(projectId, wt, 'claude', 'conv', reported)).toBe(reported)
      await write(path.join(agentHistoryDir(projectId, wt, 'claude'), '-workspace', 'conv.jsonl'))
      expect(await locateTranscript(projectId, wt, 'claude', 'conv', reported))
        .toBe(path.join('history', wt, 'claude', '-workspace', 'conv.jsonl'))
      await write(path.join(agentHistoryDir(projectId, wt, 'codex'), '2026', 'rollout-x.jsonl'))
      expect(await locateTranscript(projectId, wt, 'codex', 'x', 'codex/sessions/2026/rollout-x.jsonl'))
        .toBe(path.join('history', wt, 'codex', '2026', 'rollout-x.jsonl'))
    })

    it('names the file a host link leads to, and refuses one leading to a sibling', async () => {
      // On a host, history is reached through a directory symlink.
      const history = path.join(agentHistoryDir(projectId, wt, 'claude'), '-workspace')
      await write(path.join(history, 'host.jsonl'))
      await fs.mkdir(path.join(claudeDir(projectId), 'projects'), { recursive: true })
      await fs.symlink(history, path.join(claudeDir(projectId), 'projects', '-host-checkout'))
      expect(await locateTranscript(projectId, wt, 'claude', 'host', 'claude/projects/-host-checkout/host.jsonl'))
        .toBe(path.join('history', wt, 'claude', '-workspace', 'host.jsonl'))

      const sibling = path.join(agentHistoryDir(projectId, 'wt-b', 'claude'), '-workspace')
      await write(path.join(sibling, 'theirs.jsonl'))
      await fs.symlink(sibling, path.join(claudeDir(projectId), 'projects', '-sibling'))
      expect(await locateTranscript(projectId, wt, 'claude', 'theirs', 'claude/projects/-sibling/theirs.jsonl'))
        .toBeUndefined()
      await fs.symlink(path.join(projectDir(projectId), 'known_hosts'), path.join(history, 'kh.jsonl'))
      await write(path.join(projectDir(projectId), 'known_hosts'))
      expect(await locateTranscript(projectId, wt, 'claude', 'kh', 'claude/projects/-workspace/kh.jsonl'))
        .toBeUndefined()
    })

    it('drops any prefix the reporter never emits, and finds pi by id', async () => {
      await write(path.join(projectDir(projectId), 'claude', 'settings.json'))
      expect(await locateTranscript(projectId, wt, 'claude', 'x', 'claude/settings.json')).toBeUndefined()
      expect(await locateTranscript(projectId, wt, 'claude', 'x', undefined)).toBeUndefined()
      await write(path.join(agentHistoryDir(projectId, wt, 'pi'), '100_psid.jsonl'))
      expect(await locateTranscript(projectId, wt, 'pi', 'psid', undefined))
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
      expect(toProjectRelative({ projectId, dir: codexDir(projectId), rel: 'sessions/2026/rollout-x.jsonl' }))
        .toBe(path.join('codex', 'sessions', '2026', 'rollout-x.jsonl'))
    })

    it('refuses a path with no project-relative form', () => {
      expect(toProjectRelative({ projectId, dir: '/tmp', rel: 'elsewhere.jsonl' })).toBeNull()
      expect(toProjectRelative({ projectId, dir: claudeDir('other'), rel: 't.jsonl' })).toBeNull()
    })
  })

  describe('conversationFiles', () => {
    /** A codex rollout whose first line names its parent thread, if any. */
    async function rollout(dir: string, thread: string, parent?: string): Promise<void> {
      const source = parent === undefined ? 'cli' : { subagent: { thread_spawn: { parent_thread_id: parent } } }
      await write(path.join(dir, '2026', '10', '03', `rollout-2026-10-03T12-00-00-${thread}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id: thread, source } })}\n`)
    }

    it('gathers each tool\'s transcripts with their subagents, and acpd\'s record of a chat conversation', async () => {
      // claude: the recorded path is stale (converge moved the file), so the
      // conversation is found by id in the history, with its companion dir.
      const claudeHistory = path.join(agentHistoryDir(projectId, wt, 'claude'), '-workspace')
      await write(path.join(claudeHistory, 'cl.jsonl'))
      await write(path.join(claudeHistory, 'cl', 'subagents', 'agent-b.jsonl'))
      await write(path.join(claudeHistory, 'cl', 'subagents', 'agent-a.jsonl'))
      await write(path.join(claudeHistory, 'cl', 'tool-results', 'r1.txt'), 'out')
      // A link the workspace planted is not handed out.
      await fs.symlink(await write(path.join(tmpDir, 'secret')), path.join(claudeHistory, 'cl', 'subagents', 'agent-z.jsonl'))
      await write(path.join(acpLogDir(projectId, wt), 'cl.jsonl'))

      // codex: a child and a grandchild in the history, a fork still in the
      // shared home, and an unrelated thread.
      const codexHistory = agentHistoryDir(projectId, wt, 'codex')
      await rollout(codexHistory, 'cx')
      await rollout(codexHistory, 'cx-child', 'cx')
      await rollout(codexHistory, 'cx-grandchild', 'cx-child')
      await rollout(path.join(codexDir(projectId), 'sessions'), 'cx-fork', 'cx')
      await rollout(codexHistory, 'unrelated')

      await write(path.join(agentHistoryDir(projectId, wt, 'pi'), '100_pi.jsonl'))
      await write(path.join(acpLogDir(projectId, wt), 'oc.jsonl'))
      // The workspace's opencode database, beside a backup the pod's stop
      // cut short.
      await write(path.join(opencodeCheckpointDir(projectId, wt), 'opencode.db'))
      await write(path.join(opencodeCheckpointDir(projectId, wt), '.tmp-12.db'))

      const files = await conversationFiles(projectId, wt, [
        { tool: 'claude', mode: 'acp', agentSessionId: 'cl', transcriptPath: 'claude/projects/-home-x/cl.jsonl' },
        { tool: 'codex', mode: 'tui', agentSessionId: 'cx' },
        { tool: 'pi', mode: 'tui', agentSessionId: 'pi' },
        { tool: 'opencode', mode: 'acp', agentSessionId: 'oc' },
        { tool: 'opencode', mode: 'tui', agentSessionId: 'oc-tui' },
      ])
      const names = (id: string): string[] => (files.get(id) ?? []).map((f) => f.name)

      expect(names('cl')).toEqual([
        'cl.jsonl', 'cl/subagents/agent-a.jsonl', 'cl/subagents/agent-b.jsonl', 'cl/tool-results/r1.txt', 'acpd.jsonl',
      ])
      expect(files.get('cl')?.[0].file).toEqual({ projectId, dir: agentHistoryDir(projectId, wt, 'claude'), rel: '-workspace/cl.jsonl' })
      expect(names('cx')).toEqual([
        'rollout-2026-10-03T12-00-00-cx.jsonl',
        'rollout-2026-10-03T12-00-00-cx-child.jsonl',
        'rollout-2026-10-03T12-00-00-cx-fork.jsonl',
        'rollout-2026-10-03T12-00-00-cx-grandchild.jsonl',
      ])
      expect(names('pi')).toEqual(['100_pi.jsonl'])
      // Every opencode conversation is in the one database.
      expect(names('oc')).toEqual(['opencode.db', 'acpd.jsonl'])
      expect(files.get('oc-tui')).toMatchObject([{
        name: 'opencode.db',
        file: { projectId, dir: opencodeCheckpointDir(projectId, wt), rel: 'opencode.db' },
        sqlite: true,
        size: 3,
      }])
    })

    it('follows no link inside the history, even on a host where the project dir is fair game', async () => {
      // Containerless reads are otherwise confined to the project dir, which
      // holds siblings' checkouts.
      installFakeWorkspaceDriver({ kind: 'containerless' })
      try {
        const sibling = path.join(projectDir(projectId), 'workspaces', 'wt-b')
        await write(path.join(sibling, '.git', 'config'))
        const conversations = path.join(agentHistoryDir(projectId, wt, 'claude'), '-workspace')
        await write(path.join(conversations, 'cl.jsonl'))
        await fs.symlink(sibling, path.join(conversations, 'cl'))
        await write(path.join(conversations, 'cl2.jsonl'))
        await fs.mkdir(path.join(conversations, 'cl2'))
        await fs.symlink(sibling, path.join(conversations, 'cl2', 'subagents'))

        const files = await conversationFiles(projectId, wt, [
          { tool: 'claude', mode: 'tui', agentSessionId: 'cl' },
          { tool: 'claude', mode: 'tui', agentSessionId: 'cl2' },
        ])
        expect(files.get('cl')?.map((f) => f.name)).toEqual(['cl.jsonl'])
        expect(files.get('cl2')?.map((f) => f.name)).toEqual(['cl2.jsonl'])
      } finally {
        resetWorkspaceDriver()
      }
    })
  })

  describe('openConversationFile', () => {
    afterEach(() => { resetWorkspaceDriver() })

    const dir = (): string => opencodeCheckpointDir(projectId, wt)
    const database = { name: 'opencode.db', file: { projectId, dir: '', rel: 'opencode.db' }, sqlite: true, size: 0, mtimeMs: 0 }
    const opened = async (): Promise<Buffer | null> => {
      const fh = await openConversationFile({ ...database, file: { ...database.file, dir: dir() } })
      try {
        return fh === null ? null : await fh.readFile()
      } finally {
        await fh?.close()
      }
    }
    /** The messages a database holds, read from a copy of its bytes. */
    const messages = async (bytes: Buffer | null): Promise<string[]> => {
      const copy = path.join(tmpDir, `copy-${String(Math.random())}.db`)
      await fs.writeFile(copy, bytes ?? Buffer.alloc(0))
      const db = new DatabaseSync(`file:${copy}?immutable=1`)
      try {
        return db.prepare('select text from message').all().map((r) => String(r.text))
      } finally {
        db.close()
      }
    }

    it('copies a live host database through SQLite, and a sandboxed one byte for byte', async () => {
      await fs.mkdir(dir(), { recursive: true })
      // A writer still holds it, so its newest rows are only in the WAL.
      const live = new DatabaseSync(path.join(dir(), 'opencode.db'))
      try {
        live.exec('pragma journal_mode = wal; pragma wal_autocheckpoint = 0')
        live.exec('create table message (text text); insert into message values (\'hello\')')
        const sidecars = (await fs.readdir(dir())).sort()
        expect(sidecars).toEqual(['opencode.db', 'opencode.db-shm', 'opencode.db-wal'])
        await expect(messages(await fs.readFile(path.join(dir(), 'opencode.db')))).rejects.toThrow(/no such table/)

        installFakeWorkspaceDriver({ kind: 'containerless' })
        expect(await messages(await opened())).toEqual(['hello'])
        // Nothing is left beside the database.
        expect((await fs.readdir(dir())).sort()).toEqual(sidecars)

        // A sandboxed workspace's database is never opened with SQLite: its
        // bytes are handed out as they are.
        resetWorkspaceDriver()
        expect(await opened()).toEqual(await fs.readFile(path.join(dir(), 'opencode.db')))
      } finally {
        live.close()
      }

      // Closed cleanly, a host database is its bytes too.
      installFakeWorkspaceDriver({ kind: 'containerless' })
      expect(await fs.readdir(dir())).toEqual(['opencode.db'])
      expect(await messages(await opened())).toEqual(['hello'])
      expect(await fs.readdir(dir())).toEqual(['opencode.db'])
    })

    it('opens no live database that is, or sits beside, a link', async () => {
      // SQLite opens by path, so the path is checked first.
      installFakeWorkspaceDriver({ kind: 'containerless' })
      const elsewhere = path.join(tmpDir, 'elsewhere')
      await fs.mkdir(elsewhere)
      const other = new DatabaseSync(path.join(elsewhere, 'cookies.db'))
      try {
        other.exec('pragma journal_mode = wal; create table message (text text)')
        await fs.mkdir(dir(), { recursive: true })
        await fs.symlink(path.join(elsewhere, 'cookies.db'), path.join(dir(), 'opencode.db'))
        await fs.symlink(path.join(elsewhere, 'cookies.db-wal'), path.join(dir(), 'opencode.db-wal'))
        expect(await opened()).toBeNull()

        // A real database with a linked sidecar is refused too.
        await fs.rm(path.join(dir(), 'opencode.db'))
        await fs.copyFile(path.join(elsewhere, 'cookies.db'), path.join(dir(), 'opencode.db'))
        expect(await opened()).toBeNull()
      } finally {
        other.close()
      }
    })

    it('opens any other file as it is, and none that is gone or reached through a link', async () => {
      const plain = (rel: string) => ({ name: rel, file: { projectId, dir: dir(), rel }, size: 0, mtimeMs: 0 })
      await write(path.join(dir(), 'notes.txt'), 'plain')
      const fh = await openConversationFile(plain('notes.txt'))
      expect((await fh?.readFile())?.toString()).toBe('plain')
      await fh?.close()
      expect(await openConversationFile(plain('missing'))).toBeNull()
      await fs.symlink(path.join(dir(), 'notes.txt'), path.join(dir(), 'linked.txt'))
      expect(await openConversationFile(plain('linked.txt'))).toBeNull()
    })
  })

  describe('resolveProjectPath', () => {
    it('resolves under the recording tool\'s home or its part of this workspace\'s history', () => {
      const files = {
        claude: claudeFile('sid'),
        codex: { projectId, dir: codexDir(projectId), rel: 'sessions/rollout-x.jsonl' },
        pi: { projectId, dir: agentHistoryDir(projectId, wt, 'pi'), rel: '20260101-120000_sid.jsonl' },
      } as const
      for (const [tool, file] of Object.entries(files)) {
        const stored = toProjectRelative(file)
        expect(stored).not.toBeNull()
        expect(resolveProjectPath(projectId, wt, tool as keyof typeof files, stored ?? '')).toEqual(file)
      }
      expect(resolveProjectPath(projectId, wt, 'claude', `history/${wt}/claude/-workspace/sid.jsonl`))
        .toEqual({ projectId, dir: agentHistoryDir(projectId, wt, 'claude'), rel: '-workspace/sid.jsonl' })
    })

    it('refuses what is not under those: another tool\'s, a sibling\'s, the project\'s own files, a way out', () => {
      // The workspace controls this value, so it must not reach arbitrary
      // project files.
      expect(resolveProjectPath(projectId, wt, 'claude', 'codex/sessions/r.jsonl')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'claude', `history/${wt}/codex/r.jsonl`)).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'claude', 'history/wt-b/claude/-workspace/t.jsonl')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'claude', 'known_hosts')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'claude', 'repo/.git/config')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'claude', 'claude/../../../etc/passwd')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'opencode', 'opencode-config/x.jsonl')).toBeUndefined()
      expect(resolveProjectPath(projectId, wt, 'pi', 'pi/agent/sessions/x.jsonl')).toBeUndefined()
      // Only project-relative values are accepted.
      expect(resolveProjectPath(projectId, wt, 'claude', '/old/home/t.jsonl')).toBeUndefined()
    })
  })
})
