import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  statusFromCode,
  resolveRenamePath,
  parseNumstat,
  parseNameStatus,
  parseChangesOutput,
  buildChangesScript as buildScript,
  type ChangesLocation,
} from '#drivers/shared/workspace-changes'
import { CHANGES_BASE_UNRESOLVED } from '#drivers/contract'

// The in-pod paths the k8s driver passes; a host driver passes its own.
const LOC: ChangesLocation = {
  workspaceDir: '/workspace',
  indexFile: '/tmp/yaac-changes.idx',
  baseUnresolvedCode: CHANGES_BASE_UNRESOLVED,
}

/** The script as a driver builds it, with `LOC` applied. */
const buildChangesScript = (base?: string, defaultBase?: string): string =>
  buildScript(LOC, base, defaultBase)

describe('statusFromCode', () => {
  it('maps git status letters', () => {
    expect(statusFromCode('A')).toBe('added')
    expect(statusFromCode('M')).toBe('modified')
    expect(statusFromCode('D')).toBe('deleted')
    expect(statusFromCode('R100')).toBe('renamed')
    expect(statusFromCode('C075')).toBe('copied')
    expect(statusFromCode('T')).toBe('typechange')
    expect(statusFromCode('X')).toBe('modified') // unknown → modified
  })
})

describe('resolveRenamePath', () => {
  it('collapses rename notations to the destination', () => {
    expect(resolveRenamePath('old.ts => new.ts')).toBe('new.ts')
    expect(resolveRenamePath('src/{old => new}/file.ts')).toBe('src/new/file.ts')
    expect(resolveRenamePath('plain/path.ts')).toBe('plain/path.ts')
  })
})

describe('parseNumstat', () => {
  it('reads add/delete counts and flags binary', () => {
    const m = parseNumstat('12\t3\tsrc/a.ts\n0\t9\tsrc/b.ts\n-\t-\timg/logo.png\n')
    expect(m.get('src/a.ts')).toEqual({ additions: 12, deletions: 3, binary: false })
    expect(m.get('src/b.ts')).toEqual({ additions: 0, deletions: 9, binary: false })
    expect(m.get('img/logo.png')).toEqual({ additions: 0, deletions: 0, binary: true })
  })
  it('keys renames by destination path', () => {
    const m = parseNumstat('4\t1\tsrc/{old => new}/x.ts\n')
    expect(m.get('src/new/x.ts')).toEqual({ additions: 4, deletions: 1, binary: false })
  })
})

describe('parseNameStatus', () => {
  it('parses statuses and takes the new path for renames', () => {
    const out = parseNameStatus('A\tsrc/new.ts\nM\tsrc/app.ts\nD\tsrc/gone.ts\nR100\told.ts\trenamed.ts\n')
    expect(out).toEqual([
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'renamed.ts', status: 'renamed', oldPath: 'old.ts' },
    ])
  })
  it('captures the from-path of renames and copies, not other statuses', () => {
    const out = parseNameStatus('R096\tsrc/old.ts\tsrc/new.ts\nC075\tlib/a.ts\tlib/b.ts\nM\tsrc/app.ts\n')
    expect(out).toEqual([
      { path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts' },
      { path: 'lib/b.ts', status: 'copied', oldPath: 'lib/a.ts' },
      { path: 'src/app.ts', status: 'modified' },
    ])
  })
})

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
    '@@OK@@',
    '@@DIFF@@',
    'diff --git a/src/app.ts b/src/app.ts',
    '@@ -1 +1,2 @@',
    ' existing',
    '+added line',
  ].join('\n')

  it('merges name-status + numstat into files and captures base + diff', () => {
    const out = parseChangesOutput(raw)
    expect(out.base).toBe('abc123def')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 10, deletions: 2, binary: false },
      { path: 'src/new.ts', status: 'added', additions: 5, deletions: 0, binary: false },
    ])
    expect(out.diff).toContain('diff --git a/src/app.ts')
    expect(out.diff).toContain('+added line')
    expect(out.truncated).toBe(false)
  })

  it('flags truncation when the diff exceeds the cap', () => {
    const out = parseChangesOutput(raw, 20)
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.diff)).toBe(20)
    expect(out.files).toHaveLength(2)
  })

  // The pod cuts with `head -c`, so the cap must be in bytes here too, or a
  // cut multi-byte diff would not be flagged as truncated.
  it('measures the diff cap in bytes, not UTF-16 code units', () => {
    // 300 CJK chars = 300 code units but 900 bytes.
    const wide = [
      'BASE abc', 'FORK 1', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@OK@@', '@@DIFF@@', '交'.repeat(300),
    ].join('\n')
    const out = parseChangesOutput(wide, 500)
    expect(out.truncated).toBe(true)          // 900 bytes > 500, though 300 units < 500
    expect(Buffer.byteLength(out.diff)).toBeLessThanOrEqual(500)
    // Cut on a code point boundary, never over the cap.
    expect(out.diff).toBe('交'.repeat(166))
    expect(out.diff).not.toContain('�')
    const small = parseChangesOutput(wide, 5000)
    expect(small.truncated).toBe(false)
    expect(small.diff).toBe('交'.repeat(300))
  })

  it('carries a rename through with its old path and counts', () => {
    const renamed = [
      'BASE abc123def',
      'FORK 1',
      '@@NUMSTAT@@',
      '3\t1\tsrc/{old => new}/x.ts',
      '@@NAMESTATUS@@',
      'R096\tsrc/old/x.ts\tsrc/new/x.ts',
      '@@OK@@',
      '@@DIFF@@',
    ].join('\n')
    const out = parseChangesOutput(renamed)
    expect(out.files).toEqual([
      { path: 'src/new/x.ts', status: 'renamed', additions: 3, deletions: 1, binary: false, oldPath: 'src/old/x.ts' },
    ])
  })

  it('is empty-safe when nothing changed', () => {
    const out = parseChangesOutput('BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@OK@@\n@@DIFF@@\n')
    expect(out.base).toBe('deadbeef')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([])
    expect(out.diff).toBe('')
  })

  // Without the completion marker the run died partway; reporting an empty
  // changeset would wrongly say "No changes".
  it('rejects output with no completion marker rather than reporting no changes', () => {
    const partial = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n'
    expect(() => parseChangesOutput(partial)).toThrow(/completion marker/)
    expect(() => parseChangesOutput('')).toThrow(/completion marker/)
    const truncatedRun = [
      'BASE abc123def', 'FORK 1', '@@NUMSTAT@@', '10\t2\tsrc/app.ts', '@@NAMESTATUS@@', 'M\tsrc/app.ts',
    ].join('\n')
    expect(() => parseChangesOutput(truncatedRun)).toThrow(/completion marker/)
  })

  // FORK 0: the fork point was unresolved and the diff ran against HEAD, so
  // committed work is missing. The UI then says "nothing uncommitted".
  it('reports an unresolved fork point so an empty result is not read as no changes', () => {
    const fellBack = [
      'BASE headsha', 'FORK 0', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@OK@@', '@@DIFF@@',
    ].join('\n')
    const out = parseChangesOutput(fellBack)
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
      '@@OK@@',
      '@@DIFF@@',
      'diff --git a/changes.ts b/changes.ts',
      "+const M_NUMSTAT = '@@NUMSTAT@@'",
      "+const M_OK = '@@OK@@'",
      "+const M_DIFF = '@@DIFF@@'",
    ].join('\n')
    const out = parseChangesOutput(selfReferential)
    expect(out.files).toEqual([
      { path: 'changes.ts', status: 'modified', additions: 1, deletions: 0, binary: false },
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
    expect(s).toContain('git add -A')
    expect(s).toContain('GIT_INDEX_FILE')
    expect(s.endsWith("yaac-changes '' ''")).toBe(true)
  })

  // An unpushed branch has no origin/<b>; falling through to HEAD would
  // hide every committed change.
  it('falls back to the local ref when the branch has no origin/ counterpart', () => {
    const s = buildChangesScript()
    expect(s).toContain('git merge-base "origin/$1" HEAD 2>/dev/null || git merge-base "$1" HEAD')
    expect(s).toContain('git merge-base "origin/$2" HEAD 2>/dev/null || git merge-base "$2" HEAD')
  })

  it('reuses one stable index across polls so add -A can be incremental', () => {
    const s = buildChangesScript()
    expect(s).toContain('export GIT_INDEX_FILE=/tmp/yaac-changes.idx')
    expect(s).not.toContain('$$')            // no per-run tempfile: that discards git's stat cache
    // A stale index or orphaned lock must not fail every later poll.
    expect(s).toContain('rm -f /tmp/yaac-changes.idx /tmp/yaac-changes.idx.lock; git add -A || exit 5')
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
    expect(s.endsWith("yaac-changes 'dev' ''")).toBe(true)
    expect(s).not.toContain('origin/dev')    // the branch name is never spliced into the script body
  })

  it('passes the fork branch as the $2 default positional (graceful origin/$2 path)', () => {
    const s = buildChangesScript(undefined, 'main')
    expect(s).toContain('"origin/$2"')       // the default ref is derived from $2, never interpolated
    expect(s.endsWith("yaac-changes '' 'main'")).toBe(true)
    expect(s).not.toContain('origin/main')   // the branch name is never spliced into the script body
  })

  it('carries both an explicit base ($1) and a fork-branch default ($2)', () => {
    const s = buildChangesScript('dev', 'main')
    expect(s.endsWith("yaac-changes 'dev' 'main'")).toBe(true)
  })

  it('single-quotes both branches so shell metacharacters cannot break out of the token', () => {
    for (const evil of ['x; rm -rf /', '$(touch pwn)', '`id`', 'a && b', '| tee x']) {
      expect(buildChangesScript(evil).endsWith("yaac-changes '" + evil + "' ''")).toBe(true)
      expect(buildChangesScript(undefined, evil).endsWith("yaac-changes '' '" + evil + "'")).toBe(true)
    }
  })

  it('escapes embedded single quotes in either branch', () => {
    expect(buildChangesScript("a'b").endsWith("yaac-changes 'a'\\''b' ''")).toBe(true)
    expect(buildChangesScript(undefined, "a'b").endsWith("yaac-changes '' 'a'\\''b'")).toBe(true)
  })

  it('keeps the script body byte-identical regardless of the branches', () => {
    const body = (s: string): string => s.slice(0, s.lastIndexOf('yaac-changes'))
    expect(body(buildChangesScript('dev'))).toBe(body(buildChangesScript()))
    expect(body(buildChangesScript('x; rm -rf /', 'main'))).toBe(body(buildChangesScript()))
  })

  it('trims surrounding whitespace from both branches', () => {
    expect(buildChangesScript('  dev  ', '  main  ').endsWith("yaac-changes 'dev' 'main'")).toBe(true)
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
    repo: string, idx: string, base?: string, defaultBase?: string,
  ): { stdout: string; code: number } {
    const cmd = buildChangesScript(base, defaultBase)
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
    const out = parseChangesOutput(stdout)
    expect(out.baseResolved).toBe(true)
    expect(out.files.map((f) => f.path).sort()).toEqual(['committed.txt', 'untracked.txt'])
    expect(out.diff).toContain('+committed')
    expect(out.diff).toContain('+working')

    // The agent's own index and HEAD are untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('?? untracked.txt\n')
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
    const out = parseChangesOutput(stdout)
    expect(out.baseResolved).toBe(false)
    // Committed work is absent, hence `baseResolved: false`.
    expect(out.files.map((f) => f.path)).toEqual(['dirty.txt'])
  })

  // Never diffs against the wrong base; the exit code is the contract's, so
  // callers can answer 400.
  it('hard-fails on an explicit base that resolves nowhere', () => {
    const { repo, idx } = scratchRepo()
    const { code } = runPodScript(repo, idx, 'no-such-branch', 'main')
    expect(code).toBe(CHANGES_BASE_UNRESOLVED)
  })

  it('reuses the index across runs and recovers from a lock a killed run left', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    expect(parseChangesOutput(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['a.txt'])
    expect(fs.existsSync(idx)).toBe(true) // the index persists for the next poll

    // A second run over the reused index sees an edit and a deletion.
    fs.rmSync(path.join(repo, 'a.txt'))
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    expect(parseChangesOutput(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['b.txt'])

    fs.writeFileSync(`${idx}.lock`, '')
    const recovered = runPodScript(repo, idx, undefined, 'main')
    expect(recovered.code).toBe(0)
    expect(parseChangesOutput(recovered.stdout).files.map((f) => f.path)).toEqual(['b.txt'])
    expect(fs.existsSync(`${idx}.lock`)).toBe(false)
  })
})
