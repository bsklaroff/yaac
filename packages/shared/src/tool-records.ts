import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Legacy: repoint the absolute paths agent tools record about a host
 * (containerless) workspace when the project dir holding it moves
 * (docs/legacy-compat-shims.md). pi, opencode and codex record the
 * checkout as a conversation's cwd and refuse to resume it from another
 * one: pi in its session headers, opencode in its database, codex in its
 * rollouts and state database, and pi-acp keeps absolute session-file paths
 * in its session map. claude needs none of this, since its history links
 * are rebuilt on every launch.
 *
 * The rewrite is not tied to any tool's format: every `from/` prefix in the
 * project's agent records (its `history/`, `pi/`, `codex/` and
 * `opencode-data/` trees) becomes `to/`, in JSON, JSONL and shell files
 * (codex's shell snapshots carry the workspace's whole environment) and in
 * every text column of their SQLite databases. claude's trees are skipped:
 * their file-history holds copies of the user's own files. opencode's
 * snapshot repos are repointed too (`repointOpencodeSnapshots`).
 */
export async function rewriteToolRecordPaths(projectDir: string, from: string, to: string): Promise<void> {
  for (const part of ['history', 'pi', 'codex', 'opencode-data']) {
    for (const file of await recordFiles(path.join(projectDir, part))) {
      try {
        if (/\.(sqlite|db)$/.test(file)) await rewriteDatabase(file, `${from}/`, `${to}/`)
        else await rewriteTextFile(file, `${from}/`, `${to}/`)
      } catch (err) {
        console.error(`[yaac] could not repoint the paths in ${file}: ${String(err)}`)
      }
    }
  }
  await repointOpencodeSnapshots(path.join(projectDir, 'opencode-data'), from, to)
}

/**
 * opencode keeps each workspace's undo and revert history in a git repo
 * under `<wid>/snapshot/`, named by the sha1 of the checkout it tracks,
 * whose `core.worktree` and `alternates` name the checkout. Each repo's two
 * files are repointed, and a repo named after its old checkout is renamed
 * after the new one, or opencode would start an empty one beside it.
 */
async function repointOpencodeSnapshots(dir: string, from: string, to: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  const repos = entries
    .filter((e) => e.isFile() && e.name === 'HEAD' && path.relative(dir, e.parentPath).split(path.sep)[1] === 'snapshot')
    .map((e) => e.parentPath)
  for (const repo of repos) {
    try {
      // A `HEAD` with no `config` beside it is a reflog, not a repo.
      const config = await fs.readFile(path.join(repo, 'config'), 'utf8').catch(() => '')
      const worktree = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config)?.[1]
      if (worktree === undefined || !worktree.startsWith(`${from}/`)) continue
      for (const file of [path.join(repo, 'config'), path.join(repo, 'objects', 'info', 'alternates')]) {
        if (await fs.stat(file).then(() => true, () => false)) await rewriteTextFile(file, `${from}/`, `${to}/`)
      }
      const sha1 = (p: string): string => crypto.createHash('sha1').update(p).digest('hex')
      const renamed = path.join(path.dirname(repo), sha1(`${to}/${worktree.slice(from.length + 1)}`))
      if (path.basename(repo) === sha1(worktree) && !await fs.stat(renamed).then(() => true, () => false)) {
        await fs.rename(repo, renamed)
      }
    } catch (err) {
      console.error(`[yaac] could not repoint opencode's snapshot repo ${repo}: ${String(err)}`)
    }
  }
}

/** JSON, JSONL, shell and SQLite files under `dir`, not following links. */
async function recordFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && /\.(jsonl?|sh|sqlite|db)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !path.relative(dir, f).split(path.sep).some((seg) => seg.startsWith('claude')))
}

async function rewriteTextFile(file: string, from: string, to: string): Promise<void> {
  const text = await fs.readFile(file, 'utf8')
  if (!text.includes(from)) return
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text.replaceAll(from, to), { mode: (await fs.stat(file)).mode })
  await fs.rename(tmp, file)
}

/**
 * Replace the prefix in every text value of every ordinary table, in one
 * transaction. Virtual tables and their shadow tables (full-text indexes)
 * are left to their triggers.
 */
async function rewriteDatabase(file: string, from: string, to: string): Promise<void> {
  // Loaded only here, so other commands never pay for it (an
  // ExperimentalWarning on Node 22).
  /* eslint-disable-next-line no-restricted-syntax -- deferring it is the point; see above */
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
    const tables = (db.prepare('PRAGMA table_list').all() as Array<{ name: string; type: string; schema: string }>)
      .filter((t) => t.schema === 'main' && t.type === 'table' && !t.name.startsWith('sqlite_'))
    db.exec('BEGIN')
    for (const { name } of tables) {
      for (const { name: column } of db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>) {
        const c = quote(column)
        db.prepare(`UPDATE ${quote(name)} SET ${c} = replace(${c}, ?, ?) WHERE typeof(${c}) = 'text' AND instr(${c}, ?) > 0`)
          .run(from, to, from)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw err
  } finally {
    db.close()
  }
}
