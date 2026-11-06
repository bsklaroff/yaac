import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHANGES_BASE_UNRESOLVED,
  CHANGES_READING_GONE,
  MAX_UNTRACKED_FOLDER_FILES,
  OUTPUT_PAGE_BYTES,
  SCRATCH_OBJECTS_CAP_KB,
  forgetWorkspaceChanges,
  readChangeDiffs,
  readComparison,
  readWorkspaceChanges,
  runChangesRead,
  type ChangesReading,
  type ChangesRequest,
} from '#domain/workspaces/changes'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import type { WorkspaceChange } from '@yaac/shared/types'

// The reads run the exact scripts with `sh -c` against scratch repos, as
// streamd does, to catch shell bugs that string assertions miss.

const tmpDirs: string[] = []
afterEach(() => {
  exec.mockReset()
  for (const job of ['ws', 'fresh', 'yaac-proj-abc']) forgetWorkspaceChanges(job)
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
}
const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...GIT_ENV } })

const exec = vi.fn<WorkspaceDriver['exec']>()

/** A scratch repo as a running workspace, and ways to read its changes. */
interface Workspace {
  repo: string
  /** A job's scratch dir, which holds its private index; each job has its
   *  own, so two jobs over one checkout read it independently. */
  scratch: (job?: string) => string
  /** Every exec's command and output, in order. */
  runs: { cmd: string; out: string }[]
  /** Edit each command before it runs. */
  rewrite: (edit: (cmd: string) => string) => void
  /** Read the changes as job `ws`, against `main` unless asked otherwise. */
  read: (r?: Partial<ChangesRequest>, job?: string) => Promise<ChangesReading>
  /** Read them as a server holding nothing would, as another job. */
  fresh: (r?: Partial<ChangesRequest>) => Promise<ChangesReading>
}

/**
 * A repo on `main` with one commit (on an unborn `agent/x` when `empty`),
 * through a driver whose workspace it is, running each exec for real. With
 * `pageBytes`, the scan pages at that size, and an output over twice it
 * fails, as one over streamd's cap does.
 */
function workspace({ pageBytes, empty }: { pageBytes?: number; empty?: boolean } = {}): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-changes-'))
  tmpDirs.push(root)
  const repo = path.join(root, 'workspace')
  fs.mkdirSync(repo)
  if (empty) {
    git(repo, 'init', '-q', '-b', 'agent/x')
  } else {
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
  }
  const scratch = (job = 'ws'): string => {
    const dir = path.join(root, `scratch-${job}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const runs: Workspace['runs'] = []
  let rewrite = (cmd: string): string => cmd
  installFakeWorkspaceDriver({
    exec,
    workspacePaths: (job) => workspacePathsFixture({ workspaceDir: repo, scratchDir: scratch(job) }),
  })
  exec.mockImplementation((_job, cmd, opts) => {
    const run = rewrite(pageBytes ? cmd.replaceAll(String(OUTPUT_PAGE_BYTES), String(pageBytes)) : cmd)
    let out: string
    try {
      out = execFileSync('sh', ['-c', run], {
        input: opts?.stdin ?? '', encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...GIT_ENV },
      })
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return Promise.reject(new WorkspaceExecError(`command exited ${e.status}`, e.status, e.stdout, e.stderr))
    }
    runs.push({ cmd, out })
    if (pageBytes && Buffer.byteLength(out) > 2 * pageBytes) return Promise.reject(new Error('output over the cap'))
    return Promise.resolve({ stdout: out, stderr: '' })
  })
  const read = (r: Partial<ChangesRequest> = {}, job = 'ws'): Promise<ChangesReading> =>
    readWorkspaceChanges(job, { defaultBase: 'main', diff: true, ...r })
  return {
    repo, scratch, runs, read,
    rewrite: (edit) => { rewrite = edit },
    fresh: (r) => {
      forgetWorkspaceChanges('fresh')
      fs.rmSync(path.join(scratch('fresh'), 'yaac-changes.idx.entries'), { force: true })
      return read(r, 'fresh')
    },
  }
}

/** The paths of the lines the fills among `runs` read. */
const filled = (runs: Workspace['runs']): string[] => [...new Set(runs.filter((r) => r.out.startsWith('@@PAIR@@'))
  .flatMap((r) => r.out.split('\n').filter((l) => l.startsWith(':')).map((l) => l.split('\t').at(-1)!)))].sort()

/** The environment that reads a workspace's scratch objects as reads of
 *  the changes do. */
const scratchObjectsEnv = (repo: string, scratchDir: string): NodeJS.ProcessEnv => ({
  GIT_OBJECT_DIRECTORY: path.join(scratchDir, 'yaac-changes.idx.objects'),
  GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git/objects'),
})

/** A unified diff's parts by destination path. */
const partsOf = (diff = ''): Map<string, string> => new Map(diff.split(/(?=^diff --git )/m)
  .filter(Boolean).map((p) => [/^diff --git a\/\S+ b\/(\S+)/.exec(p)![1], p]))

describe('readWorkspaceChanges', () => {
  // A workspace created at a commit is compared against that commit, and
  // the agent's own index and HEAD are left as they were.
  it('compares against a default given as a commit, keeping committed work visible', async () => {
    const w = workspace()
    const start = git(w.repo, 'rev-parse', 'HEAD').trim()
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'committed.txt'), 'committed\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(w.repo, 'untracked.txt'), 'working\n')

    const { changes } = await w.read({ defaultBase: start })
    expect(changes.baseResolved).toBe(true)
    expect(changes.files.map((f) => f.path)).toEqual(['committed.txt', 'untracked.txt'])
    expect(changes.diff).toContain('+committed')
    expect(changes.diff).toContain('+working')
    expect(git(w.repo, 'status', '--porcelain')).toBe('?? untracked.txt\n')
  })

  // Read from the agent's real index without writing it, so a file staged
  // and then edited again shows in both stages.
  it('splits each file\'s changes into committed, staged, modified and untracked', async () => {
    const w = workspace()
    fs.writeFileSync(path.join(w.repo, 'tracked.txt'), 'one\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'tracked')
    git(w.repo, 'branch', '-q', 'fork')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'tracked.txt'), 'one\ntwo\n')
    git(w.repo, 'commit', '-qam', 'two')
    fs.writeFileSync(path.join(w.repo, 'tracked.txt'), 'one\ntwo\nthree\n')
    git(w.repo, 'add', 'tracked.txt')
    fs.writeFileSync(path.join(w.repo, 'tracked.txt'), 'one\nTWO\nthree\n')
    fs.writeFileSync(path.join(w.repo, 'new.txt'), 'a\nb\n')
    const before = git(w.repo, 'status', '--porcelain')

    const byPath = Object.fromEntries((await w.read({ base: 'fork' })).changes.files.map((f) => [f.path, f]))
    expect(byPath['tracked.txt']).toMatchObject({
      additions: 2,
      deletions: 0,
      stages: {
        committed: { additions: 1, deletions: 0 },
        staged: { additions: 1, deletions: 0 },
        modified: { additions: 1, deletions: 1 },
      },
    })
    expect(byPath['new.txt'].stages).toEqual({ untracked: { additions: 2, deletions: 0 } })
    expect(git(w.repo, 'status', '--porcelain')).toBe(before)

    const bare = (await w.read({ base: 'fork', diff: false })).changes
    expect(bare).not.toHaveProperty('diff')
    expect(bare.files.map((f) => f.path)).toEqual(['new.txt', 'tracked.txt'])
  })

  // `add -A` skips a tracked file that matches .gitignore, so without the
  // force-add it would read as deleted while it sits untouched on disk.
  it('keeps a force-added ignored file, reporting only its real changes', async () => {
    const w = workspace()
    fs.writeFileSync(path.join(w.repo, '.gitignore'), 'build/\n')
    fs.mkdirSync(path.join(w.repo, 'build'))
    fs.writeFileSync(path.join(w.repo, 'build', 'kept.txt'), 'kept\n')
    git(w.repo, 'add', '.gitignore')
    git(w.repo, 'add', '-f', 'build/kept.txt')
    git(w.repo, 'commit', '-qm', 'vendored')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    const kept = async (): Promise<WorkspaceChange | undefined> => (await w.read({ base: 'agent/x' }))
      .changes.files.find((f) => f.path === 'build/kept.txt')

    expect(await kept()).toBeUndefined()
    fs.writeFileSync(path.join(w.repo, 'build', 'kept.txt'), 'kept\nedited\n')
    expect(await kept()).toMatchObject({ status: 'modified', stages: { modified: { additions: 1, deletions: 0 } } })
    fs.rmSync(path.join(w.repo, 'build', 'kept.txt'))
    expect(await kept()).toMatchObject({ status: 'deleted', stages: { modified: { additions: 0, deletions: 1 } } })
  })

  // The force-added names come from the agent's index. Read as pathspecs,
  // a file named `:(glob)**` or `*` would force-add every ignored file,
  // credentials included.
  it('force-adds tracked ignored files by their literal names only', async () => {
    const w = workspace()
    fs.writeFileSync(path.join(w.repo, '.gitignore'), '*.log\nnode_modules/\n:(glob)**\n\\*\n')
    for (const name of [':(glob)**', '*']) fs.writeFileSync(path.join(w.repo, name), 'decoy\n')
    git(w.repo, 'add', '.gitignore')
    git(w.repo, 'add', '-f', '--', ':(literal):(glob)**', ':(literal)*')
    git(w.repo, 'commit', '-qm', 'decoys')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'secret.log'), 'token\n')
    fs.mkdirSync(path.join(w.repo, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(w.repo, 'node_modules', 'pkg', 'i.js'), 'x\n')
    const paths = async (): Promise<string[]> => (await w.read({ base: 'agent/x' })).changes.files.map((f) => f.path)

    expect(await paths()).toEqual([])
    fs.writeFileSync(path.join(w.repo, ':(glob)**'), 'decoy\nedited\n')
    // A second run, too: the private index keeps what it was given.
    expect(await paths()).toEqual([':(glob)**'])
    expect(await paths()).toEqual([':(glob)**'])
  })

  // A conflicted index has no tree; the run still answers, counting the
  // uncommitted work as modified.
  it('answers through a merge conflict in the agent\'s index', async () => {
    const w = workspace()
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'base.txt'), 'ours\n')
    git(w.repo, 'commit', '-qam', 'ours')
    git(w.repo, 'checkout', '-q', 'main')
    fs.writeFileSync(path.join(w.repo, 'base.txt'), 'theirs\n')
    git(w.repo, 'commit', '-qam', 'theirs')
    git(w.repo, 'checkout', '-q', 'agent/x')
    try { git(w.repo, 'merge', '-q', 'main') } catch { /* conflicts, as intended */ }

    const file = (await w.read()).changes.files.find((f) => f.path === 'base.txt')
    expect(file?.stages.modified).toBeDefined()
    expect(file?.stages.staged).toBeUndefined()
  })

  // FORK 0: no fork point resolved, so the diff ran against HEAD and misses
  // committed work, hence `baseResolved: false`.
  it('reports FORK 0 and only uncommitted work when no fork point resolves', async () => {
    const w = workspace()
    // Origin shares history, under another name: a deleted fork branch.
    git(w.repo, 'update-ref', 'refs/remotes/origin/other', 'HEAD')
    fs.writeFileSync(path.join(w.repo, 'committed.txt'), 'committed\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(w.repo, 'dirty.txt'), 'dirty\n')

    const { changes } = await w.read({ defaultBase: 'origin/nowhere' })
    expect(changes.baseResolved).toBe(false)
    expect(changes.files.map((f) => f.path)).toEqual(['dirty.txt'])
  })

  // An empty repo's checkout starts unborn, and its first commits share no
  // history with origin, even once another workspace pushes there first.
  it('diffs a checkout that shares no history with origin against the empty tree', async () => {
    const w = workspace({ empty: true })
    const added = async (): Promise<Record<string, unknown>> => {
      const { changes } = await w.read({ defaultBase: 'origin/main' })
      expect(changes.baseResolved).toBe(true)
      return Object.fromEntries(changes.files.map((f) => [f.path, [f.status, f.stages]]))
    }

    fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n')
    expect(await added()).toEqual({ 'a.txt': ['added', { untracked: { additions: 1, deletions: 0 } }] })

    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'first')
    git(w.repo, 'checkout', '-q', '--orphan', 'theirs')
    git(w.repo, 'commit', '-q', '--allow-empty', '-m', 'pushed elsewhere')
    git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'theirs')
    git(w.repo, 'checkout', '-q', 'agent/x')
    expect(await added()).toEqual({ 'a.txt': ['added', { committed: { additions: 1, deletions: 0 } }] })
  })

  // The status bar's ahead/behind and the explorer's tree ride on the same
  // run: the ref the base came from, and paths read from the private index.
  it('reports the base ref with HEAD\'s distance from it, and lists the checkout when asked', async () => {
    const w = workspace()
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, '.gitignore'), 'out/\n*.log\n')
    fs.writeFileSync(path.join(w.repo, 'mine.txt'), 'mine\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'agent work')
    git(w.repo, 'checkout', '-q', 'main')
    git(w.repo, 'commit', '-q', '--allow-empty', '-m', 'landed')
    git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    git(w.repo, 'checkout', '-q', 'agent/x')
    fs.rmSync(path.join(w.repo, 'base.txt'))
    fs.writeFileSync(path.join(w.repo, 'new\nline.txt'), 'n\n')
    fs.writeFileSync(path.join(w.repo, 'debug.log'), 'ignored\n')
    fs.mkdirSync(path.join(w.repo, 'out'))
    fs.writeFileSync(path.join(w.repo, 'out/a.js'), 'ignored\n')
    fs.mkdirSync(path.join(w.repo, 'empty'))
    fs.symlinkSync('mine.txt', path.join(w.repo, 'link'))

    const full = await w.read({ defaultBase: 'origin/main', diff: false, listing: 'full' })
    expect(full.ref).toEqual({ name: 'origin/main', ahead: 1, behind: 1 })
    expect(full.listing).toEqual({
      paths: ['.gitignore', 'link', 'mine.txt', 'new\nline.txt'],
      links: ['link'],
      conflicted: [],
      ignored: ['debug.log', 'out/'],
      untrackedDirs: ['empty'],
    })

    // `paths` skips the walks; no listing at all prints none. A local base
    // is compared as itself.
    const paths = await w.read({ base: 'agent/x', diff: false, listing: 'paths' })
    expect(paths.ref).toEqual({ name: 'agent/x', ahead: 0, behind: 0 })
    expect(paths.listing).toEqual({ paths: full.listing!.paths, links: ['link'], conflicted: [] })
    expect((await w.read({ diff: false })).listing).toBeUndefined()
  })

  // Never diffs against the wrong base, and a ref reaches git as one
  // literal argument, never as shell; the exit code is the contract's, so
  // callers can answer 400.
  it('hard-fails on an explicit base that resolves nowhere, shell included', async () => {
    const w = workspace()
    for (const base of ['no-such-branch', '-x', 'x; touch pwn', '$(touch pwn)', '`touch pwn`', "a'b"]) {
      await expect(w.read({ base })).rejects.toMatchObject({ code: CHANGES_BASE_UNRESOLVED })
    }
    expect(fs.existsSync(path.join(w.repo, 'pwn'))).toBe(false)
    expect((await w.read({ base: '  main  ' })).ref?.name).toBe('main')
  })

  // A run whose exec timed out keeps going in the workspace. The next one
  // waits for it rather than clearing a lock it still holds; a lock whose
  // run is gone, or one too old to trust its pid, is cleared.
  it('waits for a live earlier run and clears a dead one\'s lock', async () => {
    const w = workspace()
    const lock = path.join(w.scratch(), 'yaac-changes.idx.run')
    fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n')
    // Not this process's child, which would linger as a zombie (still
    // "alive" to `kill -0`) while the synchronous run blocks the loop.
    const holder = Number(execFileSync('sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }))
    fs.writeFileSync(lock, `${holder}\n`)
    const started = Date.now()
    await w.read()
    expect(Date.now() - started).toBeGreaterThan(500)
    expect(fs.existsSync(lock)).toBe(false)

    // The holder has exited, so its pid is dead; and an old lock is not
    // trusted even with a live pid (this test runner's own).
    for (const [pid, ageMs] of [[holder, 0], [process.pid, 3 * 60_000]] as const) {
      fs.writeFileSync(lock, `${pid}\n`)
      const when = new Date(Date.now() - ageMs)
      fs.utimesSync(lock, when, when)
      const quick = Date.now()
      await w.read()
      expect(Date.now() - quick).toBeLessThan(5_000)
    }
  })

  // An abandoned read is killed by process group, possibly while it waits
  // out another run's lock; the pid file it would have linked in must go.
  it('leaves no pid file when killed while waiting for the lock', async () => {
    const w = workspace()
    await w.read()
    const scan = w.runs[0].cmd
    const lock = path.join(w.scratch(), 'yaac-changes.idx.run')
    const holder = Number(execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }))
    fs.writeFileSync(lock, `${holder}\n`)
    const run = spawn('sh', ['-c', scan], { detached: true, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } })
    const group = -(run.pid as number)
    await new Promise((r) => setTimeout(r, 700))
    process.kill(group, 'SIGTERM')
    // The outer shell dies at once; the script's own shell runs its trap.
    const alive = (): boolean => { try { process.kill(group, 0); return true } catch { return false } }
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50))
    process.kill(holder)
    expect(fs.readdirSync(w.scratch()).filter((f) => f.startsWith('yaac-changes.idx.run.'))).toEqual([])
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${holder}\n`)
  })

  it('reuses the index across runs, past a killed run\'s lock and files deleted mid-stage', async () => {
    const w = workspace()
    const idx = path.join(w.scratch(), 'yaac-changes.idx')
    const paths = async (): Promise<string[]> => (await w.read()).changes.files.map((f) => f.path)
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n')
    expect(await paths()).toEqual(['a.txt'])
    expect(fs.existsSync(idx)).toBe(true) // the index persists for the next poll

    // A second run over the reused index sees an edit and a deletion.
    fs.rmSync(path.join(w.repo, 'a.txt'))
    fs.writeFileSync(path.join(w.repo, 'b.txt'), 'b\n')
    expect(await paths()).toEqual(['b.txt'])

    fs.writeFileSync(`${idx}.lock`, '')
    expect(await paths()).toEqual(['b.txt'])
    expect(fs.existsSync(`${idx}.lock`)).toBe(false)

    // A git whose first two stagings die the way a branch switch kills
    // them, on a file deleted between listing and adding it.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-changes-bin-'))
    tmpDirs.push(bin)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'case " $* " in *" add -A "*)',
      `  n=$(($(cat ${bin}/n 2>/dev/null || echo 0)+1)); echo $n > ${bin}/n`,
      '  [ $n -gt 2 ] || { echo "fatal: unable to stat \'gone.txt\'" >&2; exit 128; };;',
      'esac',
      `exec ${realGit} "$@"`,
    ].join('\n'), { mode: 0o755 })
    fs.writeFileSync(path.join(w.repo, 'c.txt'), 'c\n')
    w.rewrite((cmd) => `PATH=${bin}:$PATH; export PATH; ${cmd}`)
    expect(await paths()).toEqual(['b.txt', 'c.txt'])
    expect(fs.readFileSync(path.join(bin, 'n'), 'utf8').trim()).toBe('3')
    w.rewrite((cmd) => cmd)

    // An index git cannot read is seeded afresh within the run.
    fs.writeFileSync(idx, 'not an index')
    fs.writeFileSync(path.join(w.repo, 'd.txt'), 'd\n')
    expect(await paths()).toEqual(['b.txt', 'c.txt', 'd.txt'])
  })

  // A name that looks like a marker stays a name, and a diff git could not
  // finish is shown cut to nothing while the list still stands, and is not
  // kept: once git can finish it, it is read whole.
  it('reads marker-like names and fails a body git could not finish', async () => {
    const w = workspace()
    for (const name of ['@@notes.md', '@@PATHS@@', 'b.txt']) fs.writeFileSync(path.join(w.repo, name), 'n\n')
    expect((await w.read()).changes.files.map((f) => [f.path, Object.keys(f.stages)])).toEqual([
      ['@@PATHS@@', ['untracked']], ['@@notes.md', ['untracked']], ['b.txt', ['untracked']],
    ])

    fs.writeFileSync(path.join(w.repo, '.gitattributes'), 'b.txt diff=broken\n')
    git(w.repo, 'config', 'diff.broken.textconv', 'false')
    const failed = (await w.read()).changes
    expect(failed).toMatchObject({ diff: '', truncated: true })
    expect(failed.files.map((f) => f.path)).toEqual(['.gitattributes', '@@PATHS@@', '@@notes.md', 'b.txt'])
    git(w.repo, 'config', 'diff.broken.textconv', 'cat')
    const fixed = (await w.read()).changes
    expect(fixed.truncated).toBe(false)
    expect(fixed).toEqual((await w.fresh()).changes)
  })

  // A file's numstat row and body part are a function of its raw line and
  // the diff settings, so every answer, whatever the server holds, must
  // match a read from nothing: after each kind of change, including
  // settings that change every file's diff mid-session. An edit costs the
  // fill that file alone, whatever kind of file it is, and a second base,
  // as a range pane ending at the working tree polls beside the
  // workspace's own, costs nothing once both are held.
  it('answers from what it holds as a read from nothing would, filling only what changed', async () => {
    const w = workspace()
    const { repo } = w
    const file = (n: number): string => path.join(repo, `src/f${String(n).padStart(2, '0')}.txt`)
    fs.mkdirSync(path.join(repo, 'src'))
    for (let n = 0; n < 40; n++) fs.writeFileSync(file(n), `line ${n}\n`.repeat(20))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'files')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 20; n++) fs.appendFileSync(file(n), `edit ${n}\n`)
    git(repo, 'mv', 'src/f39.txt', 'moved.txt')
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    // Uncommitted work on top: edits, and files the agent never added.
    for (let n = 20; n < 30; n++) fs.appendFileSync(file(n), `edit ${n}\n`)
    for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(repo, `new${n}.txt`), `n${n}\n`)
    /** Read, check it against a read from nothing, and return the paths
     *  its fill read. */
    const expectRead = async (r: Partial<ChangesRequest> = {}): Promise<string[]> => {
      const before = w.runs.length
      const got = await w.read(r)
      const fills = filled(w.runs.slice(before))
      expect(got.changes).toEqual((await w.fresh(r)).changes)
      return fills
    }

    expect(await expectRead()).toHaveLength(37)
    const idle = w.runs.length
    expect(await expectRead()).toEqual([])
    expect(w.runs[idle].out).not.toContain('@@RAW@@')

    // An edit to a file the base has, one to a file the agent added, a new
    // file, a file put back as the base had it, and a mode change.
    for (const [change, paths] of [
      [() => fs.appendFileSync(file(3), 'more\n'), ['src/f03.txt']],
      [() => fs.appendFileSync(path.join(repo, 'added.txt'), 'more\n'), ['added.txt']],
      [() => fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n'), ['untracked.txt']],
      [() => fs.writeFileSync(file(7), 'line 7\n'.repeat(20)), ['src/f07.txt']],
      [() => fs.chmodSync(file(2), 0o755), ['src/f02.txt']],
      [() => fs.rmSync(path.join(repo, 'new3.txt')), []],
    ] as const) {
      change()
      expect(await expectRead()).toEqual(paths)
    }

    // A typechange prints two body parts for its one row, and a quoted
    // name sorts by its bytes.
    fs.rmSync(file(10))
    fs.symlinkSync('../moved.txt', file(10))
    fs.writeFileSync(path.join(repo, 'src/café.txt'), 'c\n')
    expect(await expectRead()).toEqual(['"src/caf\\303\\251.txt"', 'src/f10.txt'])

    // A read with no body fills only the counts, and the next with one
    // the parts.
    fs.appendFileSync(file(4), 'more\n')
    expect(await expectRead({ diff: false })).toEqual(['src/f04.txt'])
    expect(await expectRead()).toEqual(['src/f04.txt'])

    // Staging an edit and committing it read nothing: the staged line is
    // the unstaged one it replaces, and the committed one the base diff's.
    fs.appendFileSync(file(5), 'more\n')
    expect(await expectRead()).toEqual(['src/f05.txt'])
    git(repo, 'add', 'src/f05.txt')
    expect(await expectRead()).toEqual([])
    git(repo, 'commit', '-qm', 'f05')
    expect(await expectRead()).toEqual([])

    // Another base: once both are held, switching prints no pair.
    expect(await expectRead({ base: 'agent/x' })).not.toEqual([])
    for (const base of [undefined, 'agent/x', undefined]) {
      const at = w.runs.length
      expect(await expectRead({ base })).toEqual([])
      expect(w.runs[at].out).not.toContain('@@RAW@@')
    }

    // An attribute can turn another file binary, and rename pairing can be
    // turned off; either changes every file's key.
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'src/f01.txt -diff\n')
    expect(await expectRead()).toEqual(expect.arrayContaining((await w.fresh()).changes.files.map((f) => f.path)))
    expect((await w.read()).changes.files.find((f) => f.path === 'src/f01.txt')?.binary).toBe(true)
    git(repo, 'config', 'diff.renames', 'false')
    expect(await expectRead()).not.toEqual([])
    expect((await w.read()).changes.files.find((f) => f.path === 'moved.txt')?.status).toBe('added')
  })

  // A fill reads the lines it lacks by path, and git pairs renames among
  // the paths it is given alone. Where that differs from the whole pair (a
  // rename limit the whole pair passed), the fill's lines say so and the
  // whole pair is read instead; past 300 lines it is read whole anyway.
  it('fills by path, reading the whole pair when the paths pair differently or are too many', async () => {
    const w = workspace()
    const { repo } = w
    const body = (n: number): string => Array.from({ length: 20 }, (_, l) => `${n} line ${l}\n`).join('')
    for (let n = 0; n < 3; n++) fs.writeFileSync(path.join(repo, `old${n}.txt`), body(n))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'old')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    git(repo, 'config', 'diff.renameLimit', '2')
    const fills = (from: number): string[] => w.runs.slice(from).filter((r) => r.out.startsWith('@@PAIR@@')).map((r) => r.cmd)

    // Two files replaced by unlike ones, then one moved with a line changed:
    // three added and three deleted is past the limit, so the whole pair
    // pairs none, while the moved file's two paths alone would pair.
    for (let n = 1; n < 3; n++) {
      fs.rmSync(path.join(repo, `old${n}.txt`))
      fs.writeFileSync(path.join(repo, `new${n}.txt`), 'unlike\n'.repeat(n))
    }
    await w.read()
    fs.rmSync(path.join(repo, 'old0.txt'))
    fs.writeFileSync(path.join(repo, 'new0.txt'), `${body(0)}changed\n`)
    const before = w.runs.length
    const moved = (await w.read()).changes
    const [byPath, whole] = fills(before)
    expect(byPath).toContain("'--' 'new0.txt'")
    expect(whole).not.toContain("'--'")
    expect(moved).toEqual((await w.fresh()).changes)
    expect(moved.files.filter((f) => f.path.endsWith('0.txt')).map((f) => f.status)).toEqual(['added', 'deleted'])

    for (let n = 0; n < 301; n++) fs.writeFileSync(path.join(repo, `many${n}.txt`), `${n}\n`)
    const many = w.runs.length
    const read = (await w.read()).changes
    expect(fills(many)).toHaveLength(1)
    expect(fills(many)[0]).not.toContain("'--'")
    expect(read).toEqual((await w.fresh()).changes)
  })

  // What the fills read is kept in a file in the workspace's scratch,
  // written through the next scan's stdin, so a server restart costs a scan
  // and the file read back rather than a fill. A line cut short by a killed
  // write is dropped and the file replaced, as it is once it passes twice
  // the size of what is live.
  it('carries what it filled across a server restart in a file in scratch', async () => {
    const w = workspace()
    const entries = path.join(w.scratch(), 'yaac-changes.idx.entries')
    const lines = (): string[] => fs.readFileSync(entries, 'utf8').split('\n').filter(Boolean)
    for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(w.repo, `f${n}.txt`), `${n}\n`)
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 5; n++) fs.appendFileSync(path.join(w.repo, `f${n}.txt`), 'edit\n')
    const restarted = async (): Promise<{ changes: ChangesReading['changes']; execs: number }> => {
      forgetWorkspaceChanges('ws')
      const before = w.runs.length
      const { changes } = await w.read()
      return { changes, execs: w.runs.length - before }
    }

    const first = (await w.read()).changes
    await w.read()
    // Each file's line, the same in the base diff and the unstaged one.
    expect(lines()).toHaveLength(5)
    expect(await restarted()).toEqual({ changes: first, execs: 1 })

    fs.appendFileSync(entries, '{"k":"cut sho')
    expect(await restarted()).toEqual({ changes: first, execs: 1 })
    await w.read()
    expect(lines().map((l) => (JSON.parse(l) as { k: string }).k)).toHaveLength(5)

    for (let k = 0; k < 12; k++) {
      fs.appendFileSync(path.join(w.repo, 'f0.txt'), `edit ${k}\n`)
      await w.read()
    }
    expect(lines().length).toBeLessThanOrEqual(12)
    expect((await restarted()).changes).toEqual((await w.fresh()).changes)
  })

  // One huge file is cut at its own cap rather than using up the body, so
  // the files after it keep their parts, and an edit after it reads only
  // that file's part.
  it('cuts a huge file\'s diff short, keeping the parts of the files after it', async () => {
    const w = workspace()
    const file = (name: string): string => path.join(w.repo, name)
    for (const name of ['edit.txt', 'gone.txt', 'mode.sh', 'old.txt']) fs.writeFileSync(file(name), `${name}\n`.repeat(20))
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    fs.writeFileSync(file('big.txt'), `${'x'.repeat(60)}\n`.repeat(20_000))
    fs.appendFileSync(file('edit.txt'), 'more\n')
    fs.rmSync(file('gone.txt'))
    fs.chmodSync(file('mode.sh'), 0o755)
    fs.renameSync(file('old.txt'), file('renamed.txt'))

    const first = (await w.read()).changes
    expect(first.truncated).toBe(true)
    const got = partsOf(first.diff)
    expect([...got.keys()]).toEqual(['big.txt', 'edit.txt', 'gone.txt', 'mode.sh', 'renamed.txt'])
    expect(got.get('big.txt')).toMatch(/\n\+x+\n@@CUT@@\n$/)
    expect(Buffer.byteLength(got.get('big.txt')!)).toBeLessThan(260_000)
    expect(got.get('edit.txt')).toContain('\n+more\n')
    expect(got.get('gone.txt')).toContain('\n-gone.txt\n')
    expect(got.get('mode.sh')).toContain('\nnew mode 100755\n')
    expect(got.get('renamed.txt')).toContain('\nrename from old.txt\n')

    fs.appendFileSync(file('edit.txt'), 'again\n')
    const before = w.runs.length
    const edited = (await w.read()).changes
    expect(filled(w.runs.slice(before))).toEqual(['edit.txt'])
    expect(partsOf(edited.diff).get('edit.txt')).toContain('\n+again\n')
    expect(edited).toEqual((await w.fresh()).changes)
  })

  // A big checkout's first read, and any whose listing moved, prints more
  // than an exec can carry, so it is fetched in pages. The listing is held
  // and printed again only when a path or an ignored entry came or went.
  it('pages an output over the exec cap, and prints the listing only when it moved', async () => {
    const pageBytes = 4096
    const w = workspace({ pageBytes })
    const dir = path.join(w.repo, 'a-folder-with-a-rather-long-name/and-another-one')
    fs.mkdirSync(dir, { recursive: true })
    for (let n = 0; n < 300; n++) fs.writeFileSync(path.join(dir, `file-${n}-also-named-at-length.txt`), `${n}\n`)
    fs.writeFileSync(path.join(w.repo, '.gitignore'), '*.log\n')
    // A submodule whose changes git is told to ignore.
    const sm = path.join(w.repo, 'sm')
    fs.mkdirSync(sm)
    git(sm, 'init', '-q')
    git(sm, 'commit', '-q', '--allow-empty', '-m', 'sm')
    fs.writeFileSync(path.join(w.repo, '.gitmodules'), '[submodule "sm"]\n\tpath = sm\n\turl = ./sm\n\tignore = all\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 100; n++) fs.appendFileSync(path.join(dir, `file-${n}-also-named-at-length.txt`), 'edit\n')
    fs.writeFileSync(path.join(w.repo, 'link'), '')
    const request: Partial<ChangesRequest> = { listing: 'full' }
    /** A read, whether its scan was paged, and which listing parts it printed. */
    const read = async (r = request): Promise<{ reading: ChangesReading; printed: string; paged: boolean }> => {
      const before = w.runs.length
      const reading = await w.read(r)
      const [scan, ...rest] = w.runs.slice(before)
      const paged = scan.out.startsWith('PAGED ')
      const out = paged
        ? Buffer.concat(rest.filter((p) => p.cmd.startsWith('tail -c')).map((p) => Buffer.from(p.out, 'base64'))).toString()
        : scan.out
      const printed = [out.includes('\n@@PATHS@@\n') && 'paths', out.includes('\n@@IGNORED@@\n') && 'extras'].filter(Boolean).join(' ')
      return { reading, printed, paged }
    }
    const leftovers = (): string[] => fs.readdirSync(w.scratch()).filter((f) => f.includes('.out.'))
    const same = async (r = request): Promise<ChangesReading> => {
      const { readMs: _ms, ...fresh } = await w.fresh(r)
      return { ...fresh, readMs: expect.any(Number) as number }
    }

    const first = await read()
    expect(first).toMatchObject({ printed: 'paths extras', paged: true })
    expect(first.reading.changes.files).toHaveLength(101)
    expect(first.reading.changes.diff).toContain('+edit')
    expect(first.reading.listing?.paths).toHaveLength(305)
    expect(first.reading.listing?.ignored).toEqual([])
    // The scan's output and the fill's.
    expect(leftovers()).toHaveLength(2)

    // Nothing moved: no listing, no pair, and the next run clears the file.
    const idle = await read()
    expect(idle).toMatchObject({ printed: '', paged: false })
    expect(idle.reading).toEqual({ ...first.reading, readMs: idle.reading.readMs })
    expect(leftovers()).toEqual([])

    // An edit leaves the paths as held; an ignored file reprints only
    // those; a retyped path reprints the paths.
    fs.appendFileSync(path.join(dir, 'file-200-also-named-at-length.txt'), 'edit\n')
    expect((await read()).printed).toBe('')
    fs.writeFileSync(path.join(w.repo, 'debug.log'), '')
    const ignored = await read()
    expect(ignored).toMatchObject({ printed: 'extras', paged: false })
    expect(ignored.reading.listing?.ignored).toEqual(['debug.log'])
    fs.rmSync(path.join(w.repo, 'link'))
    fs.symlinkSync('.gitignore', path.join(w.repo, 'link'))
    const retyped = await read()
    expect(retyped.printed).toBe('paths')
    expect(retyped.reading.listing?.links).toEqual(['link'])
    expect(retyped.reading).toEqual(await same())

    // A paths listing leaves the held extras out, and keeps them.
    const paths = await read({ listing: 'paths' })
    expect(paths.printed).toBe('')
    expect(paths.reading.listing).toEqual({ paths: retyped.reading.listing!.paths, links: ['link'], conflicted: [] })
    expect((await read()).printed).toBe('')

    // `ls-files` lists a gitlink whatever `.gitmodules` says, so deleting
    // one reprints the paths.
    fs.rmSync(sm, { recursive: true })
    const unlinked = await read()
    expect(unlinked.printed).toBe('paths')
    expect(unlinked.reading.listing?.paths).not.toContain('sm')
    expect(unlinked.reading).toEqual(await same())
  })

  // Callers map the exit code (a bad base is a 400), and a transport failure
  // says nothing about the base, so both arrive as the driver raised them.
  it('passes a failed run and a transport failure through untranslated', async () => {
    installFakeWorkspaceDriver({ exec })
    const badBase = new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', '')
    exec.mockRejectedValueOnce(badBase)
    await expect(readWorkspaceChanges('yaac-proj-abc', { base: 'nope', diff: true })).rejects.toBe(badBase)
    const dial = new Error('connection refused')
    exec.mockRejectedValueOnce(dial)
    await expect(readWorkspaceChanges('yaac-proj-abc', { base: 'dev', diff: true })).rejects.toBe(dial)
  })

  // A run cut off mid-staging saves no index, so until a read succeeds each
  // gets the longer timeout, long enough for a cold index to be staged. An
  // abandoned read leaves the index as warm as it was.
  it('gives a read the longer timeout until one succeeds, and again after one fails', async () => {
    const w = workspace()
    const timeouts = (): (number | undefined)[] => exec.mock.calls.filter((c) => c[1].includes('yaac-changes')).map((c) => c[2]?.timeout)

    await w.read()
    await w.read()
    exec.mockRejectedValueOnce(new Error('stream read timeout'))
    await expect(w.read()).rejects.toThrow('stream read timeout')
    await w.read()
    const caller = new AbortController()
    exec.mockImplementationOnce((_job, _cmd, opts) => new Promise((_, reject) => {
      opts!.signal!.addEventListener('abort', () => { reject(opts!.signal!.reason as Error) })
      caller.abort()
    }))
    await expect(readWorkspaceChanges('ws', { defaultBase: 'main', diff: true }, caller.signal)).rejects.toThrow()
    await w.read()
    expect(timeouts()).toEqual([120_000, 20_000, 20_000, 120_000, 20_000, 20_000])
  })

  // An untracked folder too large to stage is left out, so an unignored
  // build output cannot stall every read. It counts only files no ignore
  // pattern covers, less those of a folder already left out below it, and
  // its tracked files are still diffed.
  it('leaves out an untracked folder over the size limit, still diffing its tracked files', async () => {
    const w = workspace()
    const write = (dir: string, n: number): void => {
      fs.mkdirSync(path.join(w.repo, dir), { recursive: true })
      for (let k = 0; k < n; k++) fs.writeFileSync(path.join(w.repo, dir, `f${k}.js`), `${dir} ${k}\n`)
    }
    fs.writeFileSync(path.join(w.repo, '.gitignore'), 'node_modules/\n')
    write('build', 1)
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'build')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    w.rewrite((cmd) => cmd.replaceAll(`>${MAX_UNTRACKED_FOLDER_FILES}`, '>5'))
    const read = (): Promise<ChangesReading> => w.read({ listing: 'paths' })
    const changed = (r: ChangesReading): string[] => r.changes.files.map((f) => f.path)

    write('build/m0', 4)
    const under = await read()
    expect(under.changes.skipped).toBeUndefined()
    expect(changed(under)).toEqual(['build/m0/f0.js', 'build/m0/f1.js', 'build/m0/f2.js', 'build/m0/f3.js'])

    write('build/m1', 4)
    write('out/big', 7)
    write('out', 1)
    write('newpkg', 3)
    write('newpkg/node_modules/dep', 10)
    fs.appendFileSync(path.join(w.repo, 'build/f0.js'), 'edited\n')
    const over = await read()
    expect(over.changes.skipped?.sort()).toEqual(['build', 'out/big'])
    expect(changed(over)).toEqual(['build/f0.js', 'newpkg/f0.js', 'newpkg/f1.js', 'newpkg/f2.js', 'out/f0.js'])
    expect(over.changes.files[0].stages).toEqual({ modified: { additions: 1, deletions: 0 } })
    expect(over.listing?.paths.filter((p) => p.startsWith('build/') || p.startsWith('out/big/'))).toEqual(['build/f0.js'])
    expect(git(w.repo, 'status', '--porcelain', '--', 'build')).toBe(' M build/f0.js\n?? build/m0/\n?? build/m1/\n')

    fs.rmSync(path.join(w.repo, 'build/m1'), { recursive: true })
    const back = await read()
    expect(back.changes.skipped).toEqual(['out/big'])
    expect(changed(back).filter((p) => p.startsWith('build/'))).toEqual([
      'build/f0.js', 'build/m0/f0.js', 'build/m0/f1.js', 'build/m0/f2.js', 'build/m0/f3.js',
    ])
  })

  // Staging writes its objects to scratch, reading the checkout's store
  // through an alternate, so polls leave nothing in the checkout. Scratch
  // starts over past its cap, and when a blob the private index names has
  // gone from the checkout (the agent added a file, reset it and pruned).
  it('stages into scratch objects, starting over past the cap or on a missing blob', async () => {
    const w = workspace()
    const objects = path.join(w.scratch(), 'yaac-changes.idx.objects')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(w.repo, 'new.txt'), 'new\n')
    let cap = String(SCRATCH_OBJECTS_CAP_KB)
    w.rewrite((cmd) => cmd.replaceAll(String(SCRATCH_OBJECTS_CAP_KB), cap))
    const read = async (): Promise<ChangesReading['changes']> => {
      forgetWorkspaceChanges('ws')
      fs.rmSync(path.join(w.scratch(), 'yaac-changes.idx.entries'), { force: true })
      return (await w.read()).changes
    }
    const has = (id: string, env: NodeJS.ProcessEnv = {}): boolean => {
      try {
        execFileSync('git', ['cat-file', '-e', id], { cwd: w.repo, stdio: 'ignore', env: { ...process.env, ...env } })
        return true
      } catch {
        return false
      }
    }
    const inScratch = scratchObjectsEnv(w.repo, w.scratch())
    const loose = git(w.repo, 'count-objects')

    const first = await read()
    expect(first.diff).toContain('+new')
    const blob = git(w.repo, 'hash-object', 'new.txt').trim()
    expect([has(blob), has(blob, inScratch), has(first.work), has(first.work, inScratch)]).toEqual([false, true, false, true])
    expect(git(w.repo, 'count-objects')).toBe(loose)

    // Older than the index, so git trusts its stat data rather than hashing
    // the racily clean file again.
    const dropped = path.join(w.repo, 'dropped.txt')
    fs.writeFileSync(dropped, 'dropped\n')
    fs.utimesSync(dropped, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    git(w.repo, 'add', 'dropped.txt')
    await read()
    git(w.repo, 'reset', '-q', 'dropped.txt')
    git(w.repo, 'prune', '--expire=now')
    expect((await read()).diff).toContain('+dropped')

    fs.writeFileSync(path.join(objects, 'junk'), 'x'.repeat(4096))
    cap = '1'
    expect((await read()).files.map((f) => f.path)).toEqual(['dropped.txt', 'new.txt'])
    expect(fs.existsSync(path.join(objects, 'junk'))).toBe(false)
  })
})

describe('readComparison', () => {
  // Both ends of a range are commits, so it needs no staging: its script
  // prints the one raw diff unless the server holds it, and the fill reads
  // only what the entries lack, sharing them with the changes read. A
  // range whose files the workspace's own diff holds costs the script
  // alone, and a range read again costs a script that prints no pair.
  it('diffs a range from what it holds, sharing what the changes read filled', async () => {
    const w = workspace()
    const main = git(w.repo, 'rev-parse', 'HEAD').trim()
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    fs.appendFileSync(path.join(w.repo, 'base.txt'), 'more\n')
    git(w.repo, 'commit', '-qam', 'edit')
    const edit = git(w.repo, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(w.repo, 'added.txt'), 'added\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'add')
    const compare = async (range: { from?: string; to: string }): Promise<{ printed: boolean; filled: string[] }> => {
      const before = w.runs.length
      const answer = await readComparison('ws', range)
      forgetWorkspaceChanges('fresh')
      expect(answer).toEqual(await readComparison('fresh', range))
      const runs = w.runs.slice(before, w.runs.findIndex((r, n) => n >= before && r.cmd.includes('scratch-fresh')))
      return { printed: runs.some((r) => r.out.includes('@@RAW@@')), filled: filled(runs) }
    }

    await w.read()
    expect(await compare({ from: 'main', to: 'HEAD' })).toEqual({ printed: false, filled: [] })
    const range = await readComparison('ws', { from: 'main', to: 'HEAD' })
    expect(range).toMatchObject({ base: main, baseResolved: true, truncated: false })
    expect(range.files.map((f) => [f.path, f.stages])).toEqual([
      ['added.txt', { committed: { additions: 1, deletions: 0 } }], ['base.txt', { committed: { additions: 1, deletions: 0 } }],
    ])
    expect(range.diff).toContain('+added')

    // One commit, against its first parent: a pair of its own, whose file
    // the range already filled.
    expect(await compare({ to: edit })).toEqual({ printed: true, filled: [] })
    expect(await compare({ to: edit })).toEqual({ printed: false, filled: [] })
    const commit = await readComparison('ws', { to: edit })
    expect(commit.commit).toMatchObject({ sha: edit, parents: [main], author: 't', message: 'edit' })
    expect(commit.files.map((f) => f.path)).toEqual(['base.txt'])

    await expect(readComparison('ws', { from: 'nowhere', to: 'HEAD' })).rejects.toMatchObject({ code: CHANGES_BASE_UNRESOLVED })
  })
})

describe('runChangesRead', () => {
  /** A read's answer with every part: a diff body and a full listing. */
  const FULL: ChangesReading = {
    changes: { base: 'b', work: 'w', baseResolved: true, files: [], diff: 'body', truncated: true },
    ref: null,
    listing: { paths: ['a'], links: [], conflicted: [], ignored: ['x/'], untrackedDirs: ['d'] },
    readMs: 1,
  }

  /** A `read` that holds every call until `release` or its abandonment,
   *  logging each request and how many ran at once. */
  function gatedRead(): {
    read: (r: ChangesRequest, signal: AbortSignal) => Promise<ChangesReading>
    asked: ChangesRequest[]
    release: () => void
    peak: () => number
  } {
    const asked: ChangesRequest[] = []
    let open!: () => void
    let gate = new Promise<void>((r) => { open = r })
    let running = 0
    let peak = 0
    return {
      asked,
      peak: () => peak,
      release: () => { open(); gate = Promise.resolve() },
      read: async (r, signal) => {
        asked.push(r)
        peak = Math.max(peak, ++running)
        try {
          await new Promise<void>((resolve, reject) => {
            void gate.then(resolve)
            signal.addEventListener('abort', () => { reject(signal.reason as Error) })
          })
        } finally {
          running--
        }
        if (r.base === 'bad') throw new Error('no such base')
        return FULL
      },
    }
  }

  // Each read walks the whole checkout, so requests waiting behind the
  // running read merge into one read asking for everything they want. None
  // joins the running read, which could predate an edit its caller made.
  it('merges queued requests into one read, answering each caller only what it asked', async () => {
    const g = gatedRead()
    const run = (r: Partial<ChangesRequest>): Promise<ChangesReading> =>
      runChangesRead('ws', { defaultBase: 'main', diff: false, ...r }, g.read)
    const first = run({ listing: 'paths' })
    await Promise.resolve()
    const again = run({ listing: 'paths' })
    const wantsDiff = run({ diff: true })
    const wantsFull = run({ listing: 'full' })
    const bare = run({})
    g.release()
    const [a, b, c, d, e] = await Promise.all([first, again, wantsDiff, wantsFull, bare])
    expect(g.asked).toEqual([
      { defaultBase: 'main', diff: false, listing: 'paths' },
      { defaultBase: 'main', diff: true, listing: 'full' },
    ])
    expect(g.peak()).toBe(1)
    expect(a.changes).not.toHaveProperty('diff')
    expect(a.listing).toEqual({ paths: ['a'], links: [], conflicted: [] })
    expect(b).toEqual(a)
    expect(c.changes.diff).toBe('body')
    expect(c).not.toHaveProperty('listing')
    expect(d.listing).toEqual(FULL.listing)
    expect(d.changes).not.toHaveProperty('diff')
    expect(e.changes).toEqual({ base: 'b', work: 'w', baseResolved: true, files: [], truncated: false })
    expect(e).not.toHaveProperty('listing')

    // A read once finished is not reused.
    await run({})
    expect(g.asked).toHaveLength(3)
  })

  // Reads against different bases share the workspace's one index, so they
  // run in turn; a failed read fails only the callers sharing it.
  it('runs reads against different bases one at a time, isolating failures', async () => {
    const g = gatedRead()
    const reads = ['dev', 'bad', 'main'].map((base) =>
      runChangesRead('ws', { base, diff: true }, g.read).then(() => 'ok', (e: Error) => e.message))
    g.release()
    expect(await Promise.all(reads)).toEqual(['ok', 'no such base', 'ok'])
    expect(g.asked.map((r) => r.base)).toEqual(['dev', 'bad', 'main'])
    expect(g.peak()).toBe(1)
  })

  // A poll the webapp replaced must not hold up the read replacing it, but
  // a read stays while any caller still wants it.
  it('abandons a read once every caller has left: a running one stops, a queued one never runs', async () => {
    const g = gatedRead()
    const leave = (): AbortController => new AbortController()
    const run = (r: Partial<ChangesRequest>, signal?: AbortSignal): Promise<string> =>
      runChangesRead('ws', { defaultBase: 'main', diff: false, ...r }, g.read, signal)
        .then(() => 'ok', (e: unknown) => (e instanceof Error && e.name === 'AbortError' ? 'left' : String(e)))
    const [poll, pane, other, stays] = [leave(), leave(), leave(), leave()]
    const polled = run({ listing: 'paths' }, poll.signal)
    await Promise.resolve()
    const opened = run({ diff: true }, pane.signal)
    const joined = run({ listing: 'paths' }, stays.signal)
    const elsewhere = run({ base: 'dev' }, other.signal)
    // @hono/node-server aborts a request with a string reason; callers
    // still get an AbortError, queued or running.
    const hungUp = 'Client connection prematurely closed.'
    poll.abort(hungUp)
    pane.abort(hungUp)
    other.abort(hungUp)
    expect(await polled).toBe('left')
    g.release()
    expect(await Promise.all([opened, joined, elsewhere])).toEqual(['ok', 'ok', 'left'])
    expect(g.asked).toEqual([
      { defaultBase: 'main', diff: false, listing: 'paths' },
      { defaultBase: 'main', diff: true, listing: 'paths' },
    ])
  })
})

describe('readChangeDiffs', () => {
  // Past the poll's cap, the Changes pane reads the files it left out, and
  // pages through a file it cut, from the trees the reading names. Both
  // must give git's own parts for those files: a rename paired with its
  // old path, and a cut file's pages adding up to its whole part.
  it('reads the parts a reading left out, and the rest of one it cut', async () => {
    const w = workspace()
    const { repo } = w
    const file = (name: string): string => path.join(repo, name)
    for (const name of ['edit.txt', 'gone.txt', 'old.txt']) fs.writeFileSync(file(name), `${name}\n`.repeat(20))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'files')
    for (let n = 1; n <= 5; n++) fs.writeFileSync(file(`big${n}.txt`), `${String(n).repeat(60)}\n`.repeat(5_000))
    fs.appendFileSync(file('edit.txt'), 'more\n')
    fs.rmSync(file('gone.txt'))
    fs.renameSync(file('old.txt'), file('renamed.txt'))
    const { changes } = await w.read()
    // The reading's trees are in its scratch objects.
    const whole = partsOf(execFileSync('git', ['diff', '--no-ext-diff', '--submodule=short', changes.base, changes.work], {
      cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...scratchObjectsEnv(repo, w.scratch()) },
    }))
    const polled = partsOf(changes.diff)
    expect([...polled.keys()]).toEqual(['big1.txt', 'big2.txt', 'big3.txt', 'big4.txt'])
    expect(polled.get('big1.txt')).toMatch(/\n@@CUT@@\n$/)

    const left = changes.files.filter((f) => !polled.has(f.path))
    const read = partsOf(await readChangeDiffs('ws', { base: changes.base, work: changes.work, files: left }))
    expect([...read.keys()]).toEqual(['big5.txt', 'edit.txt', 'gone.txt', 'renamed.txt'])
    for (const p of ['edit.txt', 'gone.txt', 'renamed.txt']) expect(read.get(p)).toBe(whole.get(p))
    expect(read.get('renamed.txt')).toContain('\nrename from old.txt\n')
    expect(read.get('big5.txt')).toMatch(/\n@@CUT@@\n$/)

    const held = polled.get('big1.txt')!.slice(0, -'@@CUT@@\n'.length)
    const rest = await readChangeDiffs('ws', {
      base: changes.base, work: changes.work, files: [{ path: 'big1.txt' }], skip: held.split('\n').length - 1,
    })
    expect(held + rest).toBe(whole.get('big1.txt'))

    await expect(readChangeDiffs('ws', { base: '0'.repeat(40), work: changes.work, files: left }))
      .rejects.toMatchObject({ code: CHANGES_READING_GONE })
    for (const bad of ['../x', '/etc/passwd', 'a\0b', '"..\\057x"']) {
      await expect(readChangeDiffs('ws', { base: changes.base, work: changes.work, files: [{ path: bad }] }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    }
  })

  // A page that starts on a line of a page or more shows the line, cut to
  // a page, then marks the part cut, so the next page goes on past it.
  it('pages past a line of a page or more', async () => {
    const w = workspace()
    const { repo } = w
    // The diff lines are 1,500,001 bytes, and exactly a page.
    fs.writeFileSync(path.join(repo, 'long.txt'), `${'h'.repeat(1_500_000)}\nsecond\n`)
    fs.writeFileSync(path.join(repo, 'page.txt'), `${'e'.repeat(999_999)}\nafter\n`)
    const { changes } = await w.read()
    for (const [name, char, next] of [['long.txt', 'h', '+second\n'], ['page.txt', 'e', '+after\n']]) {
      const polled = partsOf(changes.diff).get(name)!
      expect(polled).toMatch(/\n@@ -0,0 \+1,2 @@\n@@CUT@@\n$/)
      const page = (skip: number): Promise<string> => readChangeDiffs('ws', {
        base: changes.base, work: changes.work, files: [{ path: name }], skip,
      })
      const skip = polled.split('\n').length - 2
      expect(await page(skip)).toBe(`+${char.repeat(999_999)}\n@@CUT@@\n`)
      expect(await page(skip + 1)).toBe(next)
    }
  })
})
