import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseChangesOutput,
  buildChangesScript as buildScript,
  runChangesRead,
  type ChangesLocation,
} from '#drivers/shared/workspace-changes'
import type { WorkspaceChange } from '@yaac/shared/types'
import { CHANGES_BASE_UNRESOLVED, type ChangesReading, type ChangesRequest } from '#drivers/contract'

// The in-pod paths the k8s driver passes; a host driver passes its own.
const LOC: ChangesLocation = {
  workspaceDir: '/workspace',
  indexFile: '/tmp/yaac-changes.idx',
}

/** The script as a driver builds it, with `LOC` applied. */
const buildChangesScript = (
  base?: string, defaultBase?: string, diff = true, listing?: 'paths' | 'full',
): string => buildScript(LOC, { base, defaultBase, diff, listing })

/** The diff part of a parsed run. */
const parse = (raw: string, maxDiffBytes?: number): ReturnType<typeof parseChangesOutput>['changes'] =>
  parseChangesOutput(raw, maxDiffBytes).changes

describe('parseChangesOutput', () => {
  const raw = [
    'BASE abc123def',
    'FORK 1',
    '@@NUMSTAT@@',
    '10\t2\tsrc/app.ts',
    '5\t0\tsrc/new.ts',
    '@@NAMESTATUS@@',
    'M\tsrc/app.ts',
    'A\tsrc/new.ts',
    '@@LISTING@@', '@@OK@@',
    '@@DIFF@@',
    'diff --git a/src/app.ts b/src/app.ts',
    '@@ -1 +1,2 @@',
    ' existing',
    '+added line',
  ].join('\n')

  it('merges name-status + numstat into files and captures base + diff', () => {
    const out = parse(raw)
    expect(out.base).toBe('abc123def')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 10, deletions: 2, binary: false, stages: {} },
      { path: 'src/new.ts', status: 'added', additions: 5, deletions: 0, binary: false, stages: {} },
    ])
    expect(out.diff).toContain('diff --git a/src/app.ts')
    expect(out.diff).toContain('+added line')
    expect(out.truncated).toBe(false)
  })

  // Every name-status letter, both rename notations numstat uses, a copy,
  // and a binary file (numstat's `-` counts).
  it('reads every status, keys counts by destination path, and flags binaries', () => {
    const out = parse([
      'BASE abc', 'FORK 1', '@@NUMSTAT@@',
      '12\t3\tsrc/a.ts', '0\t9\tsrc/gone.ts', '-\t-\timg/logo.png', '2\t2\told.ts => renamed.ts',
      '1\t0\tlib/{a.ts => b.ts}', '0\t0\tlink', '4\t4\todd.ts',
      '@@NAMESTATUS@@',
      'A\tsrc/a.ts', 'D\tsrc/gone.ts', 'M\timg/logo.png', 'R100\told.ts\trenamed.ts',
      'C075\tlib/a.ts\tlib/b.ts', 'T\tlink', 'X\todd.ts',
      '@@LISTING@@', '@@OK@@', '@@DIFF@@',
    ].join('\n'))
    expect(out.files).toEqual([
      { path: 'src/a.ts', status: 'added', additions: 12, deletions: 3, binary: false, stages: {} },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 9, binary: false, stages: {} },
      { path: 'img/logo.png', status: 'modified', additions: 0, deletions: 0, binary: true, stages: {} },
      { path: 'renamed.ts', status: 'renamed', additions: 2, deletions: 2, binary: false, stages: {}, oldPath: 'old.ts' },
      { path: 'lib/b.ts', status: 'copied', additions: 1, deletions: 0, binary: false, stages: {}, oldPath: 'lib/a.ts' },
      { path: 'link', status: 'typechange', additions: 0, deletions: 0, binary: false, stages: {} },
      // An unknown letter reads as modified.
      { path: 'odd.ts', status: 'modified', additions: 4, deletions: 4, binary: false, stages: {} },
    ])
  })

  it('flags truncation when the diff exceeds the cap', () => {
    const out = parse(raw, 20)
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.diff ?? '')).toBe(20)
    expect(out.files).toHaveLength(2)
  })

  // The pod cuts with `head -c`, so the cap must be in bytes here too, or a
  // cut multi-byte diff would not be flagged as truncated.
  it('measures the diff cap in bytes, not UTF-16 code units', () => {
    // 300 CJK chars = 300 code units but 900 bytes.
    const wide = [
      'BASE abc', 'FORK 1', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@LISTING@@', '@@OK@@', '@@DIFF@@', '交'.repeat(300),
    ].join('\n')
    const out = parse(wide, 500)
    expect(out.truncated).toBe(true)          // 900 bytes > 500, though 300 units < 500
    expect(Buffer.byteLength(out.diff ?? '')).toBeLessThanOrEqual(500)
    // Cut on a code point boundary, never over the cap.
    expect(out.diff).toBe('交'.repeat(166))
    expect(out.diff).not.toContain('�')
    const small = parse(wide, 5000)
    expect(small.truncated).toBe(false)
    expect(small.diff).toBe('交'.repeat(300))
  })

  // Each stage section is its own numstat; an untracked file carries its
  // totals, since git has no diff for it outside the private index.
  it('attaches each file\'s per-stage counts', () => {
    const out = parse([
      'BASE abc', 'FORK 1',
      '@@COMMITTED@@', '4\t1\tsrc/a.ts', '2\t0\t{old => src}/moved.ts',
      '@@STAGED@@', '1\t1\tsrc/a.ts',
      '@@MODIFIED@@', '0\t3\tsrc/a.ts',
      '@@UNTRACKED@@', 'notes.md',
      '@@NUMSTAT@@', '5\t2\tsrc/a.ts', '7\t0\tnotes.md', '2\t0\tsrc/moved.ts',
      '@@NAMESTATUS@@', 'M\tsrc/a.ts', 'A\tnotes.md', 'R090\told/moved.ts\tsrc/moved.ts',
      '@@LISTING@@', '@@OK@@', '@@DIFF@@',
    ].join('\n'))
    expect(out.files.map((f) => [f.path, f.stages])).toEqual([
      ['src/a.ts', {
        committed: { additions: 4, deletions: 1 },
        staged: { additions: 1, deletions: 1 },
        modified: { additions: 0, deletions: 3 },
      }],
      ['notes.md', { untracked: { additions: 7, deletions: 0 } }],
      ['src/moved.ts', { committed: { additions: 2, deletions: 0 } }],
    ])
  })

  it('carries a rename through with its old path and counts', () => {
    const renamed = [
      'BASE abc123def',
      'FORK 1',
      '@@NUMSTAT@@',
      '3\t1\tsrc/{old => new}/x.ts',
      '@@NAMESTATUS@@',
      'R096\tsrc/old/x.ts\tsrc/new/x.ts',
      '@@LISTING@@', '@@OK@@',
      '@@DIFF@@',
    ].join('\n')
    const out = parse(renamed)
    expect(out.files).toEqual([
      { path: 'src/new/x.ts', status: 'renamed', additions: 3, deletions: 1, binary: false, stages: {}, oldPath: 'src/old/x.ts' },
    ])
  })

  it('is empty-safe when nothing changed', () => {
    const out = parse('BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@LISTING@@\n@@OK@@\n@@DIFF@@\n')
    expect(out.base).toBe('deadbeef')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([])
    expect(out.diff).toBe('')
  })

  // Without the completion marker the run died partway; reporting an empty
  // changeset would wrongly say "No changes".
  it('rejects output with no completion marker rather than reporting no changes', () => {
    const partial = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n'
    expect(() => parse(partial)).toThrow(/completion marker/)
    expect(() => parse('')).toThrow(/completion marker/)
    const truncatedRun = [
      'BASE abc123def', 'FORK 1', '@@NUMSTAT@@', '10\t2\tsrc/app.ts', '@@NAMESTATUS@@', 'M\tsrc/app.ts',
    ].join('\n')
    expect(() => parse(truncatedRun)).toThrow(/completion marker/)
  })

  // FORK 0: the fork point was unresolved and the diff ran against HEAD, so
  // committed work is missing. The UI then says "nothing uncommitted".
  it('reports an unresolved fork point so an empty result is not read as no changes', () => {
    const fellBack = [
      'BASE headsha', 'FORK 0', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@LISTING@@', '@@OK@@', '@@DIFF@@',
    ].join('\n')
    const out = parse(fellBack)
    expect(out.baseResolved).toBe(false)
    expect(out.files).toEqual([])
  })

  // A diff of this module contains the markers. Sections split on each
  // marker's first occurrence, which precedes the diff body.
  it('is not confused by markers appearing inside the diff body', () => {
    const selfReferential = [
      'BASE abc123def',
      'FORK 1',
      '@@NUMSTAT@@',
      '1\t0\tchanges.ts',
      '@@NAMESTATUS@@',
      'M\tchanges.ts',
      '@@LISTING@@', '@@OK@@',
      '@@DIFF@@',
      'diff --git a/changes.ts b/changes.ts',
      "+const M_NUMSTAT = '@@NUMSTAT@@'",
      "+const M_OK = '@@OK@@'",
      "+const M_DIFF = '@@DIFF@@'",
      '@@PATHS@@',
      '+evil',
      'REF origin/x 1 2',
    ].join('\n')
    // Nor is a listing or a ref read out of the body when none was printed.
    const read = parseChangesOutput(selfReferential)
    expect(read.listing).toBeUndefined()
    expect(read.ref).toBeNull()
    const out = parse(selfReferential)
    expect(out.files).toEqual([
      { path: 'changes.ts', status: 'modified', additions: 1, deletions: 0, binary: false, stages: {} },
    ])
    expect(out.diff).toContain("+const M_OK = '@@OK@@'")
  })
})

describe('buildChangesScript', () => {
  it('builds the default (no-base) script with two empty positionals', () => {
    const s = buildChangesScript()
    expect(s).toContain('@{upstream}')       // last-resort default fork base
    expect(s).toContain('"origin/$1"')       // explicit-base branch present but unused
    expect(s).toContain('"origin/$2"')       // default fork-branch present but unused
    expect(s).toContain('add -A --ignore-errors')
    expect(s).toContain('GIT_INDEX_FILE')
    expect(s.endsWith("yaac-changes '' '' diff ''")).toBe(true)
  })

  // An unpushed branch has no origin/<b>; falling through to HEAD would
  // hide every committed change.
  it('falls back to the local ref when the branch has no origin/ counterpart', () => {
    const s = buildChangesScript()
    expect(s).toContain('for r in "origin/$1" "$1"; do')
    expect(s).toContain('for r in "origin/$2" "$2" "@{upstream}"; do')
  })

  it('reuses one stable index across polls so add -A can be incremental', () => {
    const s = buildChangesScript()
    expect(s).toContain('export GIT_INDEX_FILE=/tmp/yaac-changes.idx')
    expect(s).not.toMatch(/GIT_INDEX_FILE=\S*\$\$/) // no per-run index: that discards git's stat cache
    // A stale index or orphaned lock must not fail every later poll.
    expect(s).toContain('seed; add || { rm -f /tmp/yaac-changes.idx /tmp/yaac-changes.idx.lock; seed; add || exit 5; }')
  })

  // The completion marker prints only after every file-list command passed.
  it('checks each file-list command and marks completion', () => {
    const s = buildChangesScript()
    expect(s).toContain('--numstat "$base" || exit 6')
    expect(s).toContain('--name-status "$base" || exit 6')
    expect(s.indexOf('@@OK@@')).toBeGreaterThan(s.indexOf('--name-status'))
    expect(s.indexOf('@@OK@@')).toBeLessThan(s.indexOf('@@DIFF@@'))
  })

  it('reports whether a fork point was found and bounds the diff pod-side', () => {
    const s = buildChangesScript()
    expect(s).toContain('printf "FORK %s\\n" "$fork"')
    expect(s).toContain('fork=0')
    expect(s).toContain('head -c 2000000')   // 2× the response cap — see POD_DIFF_CAP_BYTES
  })

  it('passes an explicit base as the pod sh $1 positional (diffed against origin/$1)', () => {
    const s = buildChangesScript('dev')
    expect(s).toContain('"origin/$1"')       // the ref is derived from $1, never interpolated
    expect(s.endsWith("yaac-changes 'dev' '' diff ''")).toBe(true)
    expect(s).not.toContain('origin/dev')    // the branch name is never spliced into the script body
  })

  it('passes the fork branch as the $2 default positional (graceful origin/$2 path)', () => {
    const s = buildChangesScript(undefined, 'main')
    expect(s).toContain('"origin/$2"')       // the default ref is derived from $2, never interpolated
    expect(s.endsWith("yaac-changes '' 'main' diff ''")).toBe(true)
    expect(s).not.toContain('origin/main')   // the branch name is never spliced into the script body
  })

  it('leaves the diff body out when asked, keeping the file list', () => {
    const s = buildChangesScript('dev', 'main', false)
    expect(s.endsWith("yaac-changes 'dev' 'main' nodiff ''")).toBe(true)
    expect(s).toContain('[ "$3" = nodiff ] || {')
  })

  it('carries both an explicit base ($1) and a fork-branch default ($2)', () => {
    const s = buildChangesScript('dev', 'main')
    expect(s.endsWith("yaac-changes 'dev' 'main' diff ''")).toBe(true)
  })

  it('single-quotes both branches so shell metacharacters cannot break out of the token', () => {
    for (const evil of ['x; rm -rf /', '$(touch pwn)', '`id`', 'a && b', '| tee x']) {
      expect(buildChangesScript(evil).endsWith("yaac-changes '" + evil + "' '' diff ''")).toBe(true)
      expect(buildChangesScript(undefined, evil).endsWith("yaac-changes '' '" + evil + "' diff ''")).toBe(true)
    }
  })

  it('escapes embedded single quotes in either branch', () => {
    expect(buildChangesScript("a'b").endsWith("yaac-changes 'a'\\''b' '' diff ''")).toBe(true)
    expect(buildChangesScript(undefined, "a'b").endsWith("yaac-changes '' 'a'\\''b' diff ''")).toBe(true)
  })

  it('keeps the script body byte-identical regardless of the branches', () => {
    const body = (s: string): string => s.slice(0, s.lastIndexOf('yaac-changes'))
    expect(body(buildChangesScript('dev'))).toBe(body(buildChangesScript()))
    expect(body(buildChangesScript('x; rm -rf /', 'main'))).toBe(body(buildChangesScript()))
  })

  it('trims surrounding whitespace from both branches', () => {
    expect(buildChangesScript('  dev  ', '  main  ').endsWith("yaac-changes 'dev' 'main' diff ''")).toBe(true)
  })

  // The tests below run the exact script with `sh -c` against scratch repos,
  // as streamd does, to catch shell bugs that string assertions miss. Only
  // the two in-pod paths are redirected.

  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  })

  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  }
  const git = (repo: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })

  /**
   * A repo on `main` with one commit, plus an index path outside it (as in
   * the pod), so `git add -A` does not stage the index itself.
   */
  function scratchRepo(): { repo: string; idx: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-changes-'))
    tmpDirs.push(root)
    const repo = path.join(root, 'workspace')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    return { repo, idx: path.join(root, 'scratch.idx') }
  }

  function runPodScript(
    repo: string, idx: string, base?: string, defaultBase?: string, diff = true, listing?: 'paths' | 'full',
  ): { stdout: string; code: number } {
    const cmd = buildChangesScript(base, defaultBase, diff, listing)
      .replace('cd /workspace ', `cd ${repo} `)
      .replaceAll('/tmp/yaac-changes.idx', idx)
    try {
      return {
        stdout: execFileSync('sh', ['-c', cmd], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV },
        }),
        code: 0,
      }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      return { stdout: e.stdout ?? '', code: e.status ?? 1 }
    }
  }

  // Falling through to HEAD would hide every commit.
  it('resolves a fork branch that exists only locally, keeping committed work visible', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'working\n')

    // `main` exists locally; `origin/main` does not.
    const { stdout, code } = runPodScript(repo, idx, undefined, 'main')
    expect(code).toBe(0)
    const out = parse(stdout)
    expect(out.baseResolved).toBe(true)
    expect(out.files.map((f) => f.path).sort()).toEqual(['committed.txt', 'untracked.txt'])
    expect(out.diff).toContain('+committed')
    expect(out.diff).toContain('+working')

    // The agent's own index and HEAD are untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('?? untracked.txt\n')
  })

  // Read from the agent's real index without writing it, so a file staged
  // and then edited again shows in both stages.
  it('splits each file\'s changes into committed, staged, modified and untracked', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'tracked')
    git(repo, 'branch', '-q', 'fork')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n')
    git(repo, 'commit', '-qam', 'two')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n')
    git(repo, 'add', 'tracked.txt')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\n')
    const before = git(repo, 'status', '--porcelain')

    const { stdout, code } = runPodScript(repo, idx, 'fork')
    expect(code).toBe(0)
    const byPath = Object.fromEntries(parse(stdout).files.map((f) => [f.path, f]))
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
    expect(git(repo, 'status', '--porcelain')).toBe(before)

    const bare = runPodScript(repo, idx, 'fork', undefined, false)
    expect(bare.code).toBe(0)
    const listed = parse(bare.stdout)
    expect(listed).not.toHaveProperty('diff')
    expect(listed.files.map((f) => f.path).sort()).toEqual(['new.txt', 'tracked.txt'])
  })

  // The committed numstat is cached by base and HEAD; a new commit moves
  // HEAD and refreshes it. The agent's index is only ever copied, so even
  // a held lock is left alone.
  it('caches the committed stage until HEAD moves, never writing the agent\'s index', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'one.txt'), 'one\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'one')
    const stagesOf = (): Record<string, unknown> => Object.fromEntries(
      parse(runPodScript(repo, idx, 'main').stdout).files.map((f) => [f.path, f.stages]))

    expect(stagesOf()).toEqual({ 'one.txt': { committed: { additions: 1, deletions: 0 } } })
    const cached = fs.readFileSync(`${idx}.committed`, 'utf8')
    expect(cached.split('\n')[0]).toBe(`${git(repo, 'merge-base', 'main', 'HEAD').trim()} ${git(repo, 'rev-parse', 'HEAD').trim()}`)

    fs.writeFileSync(path.join(repo, 'one.txt'), 'one\ntwo\n')
    git(repo, 'commit', '-qam', 'two')
    const agentIndex = path.join(repo, '.git', 'index')
    fs.writeFileSync(`${agentIndex}.lock`, '')
    const before = fs.statSync(agentIndex)
    expect(stagesOf()).toEqual({ 'one.txt': { committed: { additions: 2, deletions: 0 } } })
    const after = fs.statSync(agentIndex)
    expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size])
    expect(fs.existsSync(`${agentIndex}.lock`)).toBe(true)
  })

  // `add -A` skips a tracked file that matches .gitignore, so without the
  // force-add it would read as deleted while it sits untouched on disk.
  it('keeps a force-added ignored file, reporting only its real changes', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n')
    fs.mkdirSync(path.join(repo, 'build'))
    fs.writeFileSync(path.join(repo, 'build', 'kept.txt'), 'kept\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'add', '-f', 'build/kept.txt')
    git(repo, 'commit', '-qm', 'vendored')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    const kept = (): WorkspaceChange | undefined => parse(runPodScript(repo, idx, 'agent/x').stdout)
      .files.find((f) => f.path === 'build/kept.txt')

    expect(kept()).toBeUndefined()
    fs.writeFileSync(path.join(repo, 'build', 'kept.txt'), 'kept\nedited\n')
    expect(kept()).toMatchObject({ status: 'modified', stages: { modified: { additions: 1, deletions: 0 } } })
    fs.rmSync(path.join(repo, 'build', 'kept.txt'))
    expect(kept()).toMatchObject({ status: 'deleted', stages: { modified: { additions: 0, deletions: 1 } } })
  })

  // The force-added names come from the agent's index. Read as pathspecs,
  // a file named `:(glob)**` or `*` would force-add every ignored file,
  // credentials included.
  it('force-adds tracked ignored files by their literal names only', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\nnode_modules/\n:(glob)**\n\\*\n')
    for (const name of [':(glob)**', '*']) fs.writeFileSync(path.join(repo, name), 'decoy\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'add', '-f', '--', ':(literal):(glob)**', ':(literal)*')
    git(repo, 'commit', '-qm', 'decoys')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'secret.log'), 'token\n')
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'i.js'), 'x\n')
    const paths = (): string[] => parse(runPodScript(repo, idx, 'agent/x').stdout).files.map((f) => f.path)

    expect(paths()).toEqual([])
    fs.writeFileSync(path.join(repo, ':(glob)**'), 'decoy\nedited\n')
    // A second run, too: the private index keeps what it was given.
    expect(paths()).toEqual([':(glob)**'])
    expect(paths()).toEqual([':(glob)**'])
  })

  // A conflicted index has no tree; the run still answers, counting the
  // uncommitted work as modified.
  it('answers through a merge conflict in the agent\'s index', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'ours\n')
    git(repo, 'commit', '-qam', 'ours')
    git(repo, 'checkout', '-q', 'main')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'theirs\n')
    git(repo, 'commit', '-qam', 'theirs')
    git(repo, 'checkout', '-q', 'agent/x')
    try { git(repo, 'merge', '-q', 'main') } catch { /* conflicts, as intended */ }

    const { stdout, code } = runPodScript(repo, idx, 'main')
    expect(code).toBe(0)
    const file = parse(stdout).files.find((f) => f.path === 'base.txt')
    expect(file?.stages.modified).toBeDefined()
    expect(file?.stages.staged).toBeUndefined()
  })

  it('reports FORK 0 and only uncommitted work when no fork point resolves', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')

    // No remote, upstream or local branch of that name.
    const { stdout, code } = runPodScript(repo, idx, undefined, 'nowhere')
    expect(code).toBe(0)
    const out = parse(stdout)
    expect(out.baseResolved).toBe(false)
    // Committed work is absent, hence `baseResolved: false`.
    expect(out.files.map((f) => f.path)).toEqual(['dirty.txt'])
  })

  // The status bar's ahead/behind and the explorer's tree ride on the same
  // run: the ref the base came from, and paths read from the private index.
  it('reports the base ref with HEAD\'s distance from it, and lists the checkout when asked', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n*.log\n')
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'agent work')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'landed')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    git(repo, 'checkout', '-q', 'agent/x')
    fs.rmSync(path.join(repo, 'base.txt'))
    fs.writeFileSync(path.join(repo, 'new\nline.txt'), 'n\n')
    fs.writeFileSync(path.join(repo, 'debug.log'), 'ignored\n')
    fs.mkdirSync(path.join(repo, 'out'))
    fs.writeFileSync(path.join(repo, 'out/a.js'), 'ignored\n')
    fs.mkdirSync(path.join(repo, 'empty'))
    fs.symlinkSync('mine.txt', path.join(repo, 'link'))

    const full = runPodScript(repo, idx, undefined, 'main', false, 'full')
    expect(full.code).toBe(0)
    const read = parseChangesOutput(full.stdout)
    expect(read.ref).toEqual({ name: 'origin/main', ahead: 1, behind: 1 })
    expect(read.listing).toEqual({
      paths: ['.gitignore', 'link', 'mine.txt', 'new\nline.txt'],
      links: ['link'],
      conflicted: [],
      ignored: ['debug.log', 'out/'],
      untrackedDirs: ['empty'],
    })

    // `paths` skips the walks; no listing at all prints none. A local base
    // is compared as itself.
    const paths = parseChangesOutput(runPodScript(repo, idx, 'agent/x', undefined, false, 'paths').stdout)
    expect(paths.ref).toEqual({ name: 'agent/x', ahead: 0, behind: 0 })
    expect(paths.listing).toEqual({ paths: read.listing!.paths, links: ['link'], conflicted: [] })
    expect(parseChangesOutput(runPodScript(repo, idx, undefined, 'main', false).stdout).listing).toBeUndefined()
  })

  // Never diffs against the wrong base; the exit code is the contract's, so
  // callers can answer 400.
  it('hard-fails on an explicit base that resolves nowhere', () => {
    const { repo, idx } = scratchRepo()
    const { code } = runPodScript(repo, idx, 'no-such-branch', 'main')
    expect(code).toBe(CHANGES_BASE_UNRESOLVED)
  })

  // A run whose exec timed out keeps going in the workspace. The next one
  // waits for it rather than clearing a lock it still holds; a lock whose
  // run is gone, or one too old to trust its pid, is cleared.
  it('waits for a live earlier run and clears a dead one\'s lock', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    // Not this process's child, which would linger as a zombie (still
    // "alive" to `kill -0`) while the synchronous run blocks the loop.
    const holder = Number(execFileSync('sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }))
    fs.writeFileSync(`${idx}.run`, `${holder}\n`)
    const started = Date.now()
    const waited = runPodScript(repo, idx, undefined, 'main')
    expect(waited.code).toBe(0)
    expect(Date.now() - started).toBeGreaterThan(500)
    expect(fs.existsSync(`${idx}.run`)).toBe(false)

    // The holder has exited, so its pid is dead; and an old lock is not
    // trusted even with a live pid (this test runner's own).
    for (const [pid, ageMs] of [[holder, 0], [process.pid, 3 * 60_000]] as const) {
      fs.writeFileSync(`${idx}.run`, `${pid}\n`)
      const when = new Date(Date.now() - ageMs)
      fs.utimesSync(`${idx}.run`, when, when)
      const quick = Date.now()
      expect(runPodScript(repo, idx, undefined, 'main').code).toBe(0)
      expect(Date.now() - quick).toBeLessThan(5_000)
    }
  })

  it('reuses the index across runs and recovers from a lock a killed run left', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    expect(parse(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['a.txt'])
    expect(fs.existsSync(idx)).toBe(true) // the index persists for the next poll

    // A second run over the reused index sees an edit and a deletion.
    fs.rmSync(path.join(repo, 'a.txt'))
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    expect(parse(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['b.txt'])

    fs.writeFileSync(`${idx}.lock`, '')
    const recovered = runPodScript(repo, idx, undefined, 'main')
    expect(recovered.code).toBe(0)
    expect(parse(recovered.stdout).files.map((f) => f.path)).toEqual(['b.txt'])
    expect(fs.existsSync(`${idx}.lock`)).toBe(false)
  })
})

describe('runChangesRead', () => {
  /** A read's answer with every part: a diff body and a full listing. */
  const FULL: ChangesReading = {
    changes: { base: 'b', baseResolved: true, files: [], diff: 'body', truncated: true },
    ref: null,
    listing: { paths: ['a'], links: [], conflicted: [], ignored: ['x/'], untrackedDirs: ['d'] },
  }

  /** A `read` that holds every call until `release`, logging each request
   *  and how many ran at once. */
  function gatedRead(): {
    read: (r: ChangesRequest) => Promise<ChangesReading>
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
      read: async (r) => {
        asked.push(r)
        peak = Math.max(peak, ++running)
        await gate
        running--
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
    expect(e.changes).toEqual({ base: 'b', baseResolved: true, files: [], truncated: false })
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
})
