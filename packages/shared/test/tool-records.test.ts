import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { rewriteToolRecordPaths } from '#tool-records'

let root: string
const from = (): string => path.join(root, '.yaac')
const to = (): string => path.join(root, '.yaac-server')
const project = (): string => path.join(from(), 'global', 'projects', 'p1')
const checkout = (dataDir: string): string => path.join(dataDir, 'global', 'projects', 'p1', 'workspaces', 'w1')

async function write(rel: string, text: string): Promise<string> {
  const file = path.join(project(), rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

/** A database with an ordinary table and a full-text index over it. */
function database(file: string, cwd: string): void {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, rollout_path TEXT, tokens INTEGER, data BLOB);
    CREATE VIRTUAL TABLE threads_fts USING fts5(cwd);`)
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('t1', cwd, `${cwd}/../../history/w1/codex/r.jsonl`, 3, Buffer.from(cwd))
  db.prepare('INSERT INTO threads_fts VALUES (?)').run(cwd)
  db.close()
}

function rows(file: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT cwd, rollout_path, tokens, data FROM threads').all()
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-records-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('rewriteToolRecordPaths', () => {
  it('repoints pi, opencode and codex records, and leaves claude and other paths alone', async () => {
    const old = checkout(from())
    const header = `{"type":"session","id":"s1","cwd":"${old}"}\n{"type":"message","text":"hi"}\n`
    const pi = await write('history/w1/pi/s1.jsonl', header)
    const map = await write('pi/pi-acp/session-map.json', JSON.stringify({ s1: { cwd: old, sessionFile: `${old}/../../history/w1/pi/s1.jsonl` } }))
    const rollout = await write('history/w1/codex/2026/r.jsonl', `{"type":"session_meta","payload":{"cwd":"${old}"}}\n`)
    const snapshot = await write('codex/shell_snapshots/s1.sh', `declare -x HOME="${old}/home"\n`)
    const clientTier = await write('codex/config.json', JSON.stringify({ dir: `${from()}-client/x` }))
    const fileHistory = await write('history/w1/claude-file-history/s1/a.json', JSON.stringify({ cwd: old }))
    const transcript = await write('history/w1/claude/-workspace/s1.jsonl', `{"cwd":"${old}"}\n`)
    await fs.mkdir(path.join(project(), 'history/w1/codex-sqlite'), { recursive: true })
    await fs.mkdir(path.join(project(), 'opencode-data/w1'), { recursive: true })
    const codexDb = path.join(project(), 'history/w1/codex-sqlite/state_5.sqlite')
    const opencodeDb = path.join(project(), 'opencode-data/w1/opencode.db')
    database(codexDb, old)
    database(opencodeDb, old)

    await rewriteToolRecordPaths(project(), from(), to())

    const now = checkout(to())
    expect(await fs.readFile(pi, 'utf8')).toBe(header.replace(old, now))
    expect(JSON.parse(await fs.readFile(map, 'utf8'))).toEqual({
      s1: { cwd: now, sessionFile: `${now}/../../history/w1/pi/s1.jsonl` },
    })
    expect(await fs.readFile(rollout, 'utf8')).toContain(`"cwd":"${now}"`)
    expect(await fs.readFile(snapshot, 'utf8')).toBe(`declare -x HOME="${now}/home"\n`)
    for (const db of [codexDb, opencodeDb]) {
      // Text is repointed; numbers and blobs are not text and stay as they were.
      expect(rows(db)).toEqual([{ cwd: now, rollout_path: `${now}/../../history/w1/codex/r.jsonl`, tokens: 3, data: new Uint8Array(Buffer.from(old)) }])
    }
    // The client tier shares the old prefix but not its trailing slash.
    expect(JSON.parse(await fs.readFile(clientTier, 'utf8'))).toEqual({ dir: `${from()}-client/x` })
    // claude's trees are never rewritten.
    expect(JSON.parse(await fs.readFile(fileHistory, 'utf8'))).toEqual({ cwd: old })
    expect(await fs.readFile(transcript, 'utf8')).toContain(old)
  })

  it('repoints and renames opencode snapshot repos named after their checkout', async () => {
    const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' })
    const old = checkout(from())
    await fs.mkdir(old, { recursive: true })
    git('-C', old, 'init', '-q')
    await fs.writeFile(path.join(old, 'a.txt'), 'one\n')
    const sha1 = (p: string): string => crypto.createHash('sha1').update(p).digest('hex')
    const repo = path.join(project(), 'opencode-data', 'w1', 'snapshot', 'proj', sha1(old))
    await fs.mkdir(repo, { recursive: true })
    git('init', '-q', '--bare', repo)
    git('--git-dir', repo, 'config', 'core.bare', 'false')
    git('--git-dir', repo, 'config', 'core.worktree', old)
    await fs.writeFile(path.join(repo, 'objects', 'info', 'alternates'), `${path.join(old, '.git', 'objects')}\n`)
    git('--git-dir', repo, 'add', '.')
    const tree = git('--git-dir', repo, 'write-tree').trim()

    await rewriteToolRecordPaths(project(), from(), to())
    await fs.rename(from(), to())

    const now = checkout(to())
    const moved = path.join(to(), 'global', 'projects', 'p1', 'opencode-data', 'w1', 'snapshot', 'proj', sha1(now))
    expect(git('--git-dir', moved, 'config', 'core.worktree').trim()).toBe(now)
    // The snapshot still diffs against the checkout at its new path.
    await fs.writeFile(path.join(now, 'a.txt'), 'two\n')
    expect(git('--git-dir', moved, 'diff', '--name-only', tree).trim()).toBe('a.txt')
  })
})
