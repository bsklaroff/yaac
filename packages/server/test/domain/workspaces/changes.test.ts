import { describe, it, expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHANGES_BASE_UNRESOLVED,
  CHANGES_READING_GONE,
  SCRATCH_OBJECTS_CAP_KB,
  forgetWorkspaceChanges,
  readChangeDiffs,
  readComparison,
  runChangesRead,
  type ChangesReading,
  type ChangesRequest,
} from '#domain/workspaces/changes'
import { GIT_ENV, filled, git, partsOf, scratchObjectsEnv, tmpDirs, workspace } from '#test/support/changes-workspace'
import type { WorkspaceChange } from '@yaac/shared/types'

// What a read of the changes reports, and how it takes its turn. What it
// holds between reads is in changes-held.test.ts and its caps in
// changes-limits.test.ts: three files, so they run side by side.

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
    // A blob gone from under the reading answers the same, and has the next
    // scan seed afresh.
    const blob = git(repo, 'hash-object', 'edit.txt').trim()
    fs.rmSync(path.join(w.scratch(), 'yaac-changes.idx.objects', blob.slice(0, 2), blob.slice(2)))
    await expect(readChangeDiffs('ws', { base: changes.base, work: changes.work, files: [{ path: 'edit.txt' }] }))
      .rejects.toMatchObject({ code: CHANGES_READING_GONE })
    expect(fs.existsSync(path.join(w.scratch(), 'yaac-changes.idx.reseed'))).toBe(true)
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
