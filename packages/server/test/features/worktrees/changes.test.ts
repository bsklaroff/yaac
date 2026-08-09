import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('#platform/k8s/stream-relay', () => ({
  podExec: vi.fn(),
}))
vi.mock('#platform/git', () => ({
  worktreeUpstreamBranch: vi.fn(),
}))

import { podExec } from '#platform/k8s/stream-relay'
import { worktreeUpstreamBranch } from '#platform/git'
import { repoDir } from '@yaac/shared/project-paths'
import {
  statusFromCode,
  resolveRenamePath,
  parseNumstat,
  parseNameStatus,
  parseChangesOutput,
  buildChangesScript,
  getWorktreeChanges,
  worktreeForkFallback,
} from '#features/worktrees/changes'

const mockExec = vi.mocked(podExec)
const mockUpstream = vi.mocked(worktreeUpstreamBranch)

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
    // The file list is still complete.
    expect(out.files).toHaveLength(2)
  })

  // The cap is BYTES on both sides — the pod cuts with `head -c`. Measuring
  // UTF-16 code units here would call a multi-byte diff that the pod had
  // already cut "not truncated", handing the client a silently severed diff.
  it('measures the diff cap in bytes, not UTF-16 code units', () => {
    // 300 CJK chars = 300 code units but 900 bytes.
    const wide = [
      'BASE abc', 'FORK 1', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@OK@@', '@@DIFF@@', '交'.repeat(300),
    ].join('\n')
    const out = parseChangesOutput(wide, 500)
    expect(out.truncated).toBe(true)          // 900 bytes > 500, though 300 units < 500
    expect(Buffer.byteLength(out.diff)).toBeLessThanOrEqual(500)
    // Cut on a code point boundary: no replacement char, and 500 is a real
    // ceiling (a blind byte slice would decode to 501 bytes here).
    expect(out.diff).toBe('交'.repeat(166))
    expect(out.diff).not.toContain('�')
    // Well under the cap in bytes stays untouched.
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

  // A run that dies partway used to reach the UI as a perfectly ordinary empty
  // changeset — the "No changes" lie. The completion marker is what separates
  // the two, so its absence must be an error, however well-formed the rest is.
  it('rejects output with no completion marker rather than reporting no changes', () => {
    const partial = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n'
    expect(() => parseChangesOutput(partial)).toThrow(/completion marker/)
    expect(() => parseChangesOutput('')).toThrow(/completion marker/)
    // Even a full-looking file list is refused when the marker never arrived.
    const truncatedRun = [
      'BASE abc123def', 'FORK 1', '@@NUMSTAT@@', '10\t2\tsrc/app.ts', '@@NAMESTATUS@@', 'M\tsrc/app.ts',
    ].join('\n')
    expect(() => parseChangesOutput(truncatedRun)).toThrow(/completion marker/)
  })

  // FORK 0 means the fork point was unresolvable and the diff ran against HEAD,
  // so committed work is missing. The flag is what lets the UI say "nothing
  // uncommitted" instead of "no changes".
  it('reports an unresolved fork point so an empty result is not read as no changes', () => {
    const fellBack = [
      'BASE headsha', 'FORK 0', '@@NUMSTAT@@', '@@NAMESTATUS@@', '@@OK@@', '@@DIFF@@',
    ].join('\n')
    const out = parseChangesOutput(fellBack)
    expect(out.baseResolved).toBe(false)
    expect(out.files).toEqual([])
  })

  // The markers are literal strings, and a diff that touches this very module
  // contains them. Each section is bounded by the FIRST occurrence of its
  // marker, all of which precede the diff body, so the body cannot re-split it.
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

  // A session forked from a branch that was never pushed has no origin/<b> at
  // all; without a local-ref attempt it falls through to HEAD and every
  // committed change silently disappears from the pane.
  it('falls back to the local ref when the branch has no origin/ counterpart', () => {
    const s = buildChangesScript()
    expect(s).toContain('git merge-base "origin/$1" HEAD 2>/dev/null || git merge-base "$1" HEAD')
    expect(s).toContain('git merge-base "origin/$2" HEAD 2>/dev/null || git merge-base "$2" HEAD')
  })

  it('reuses one stable index across polls so add -A can be incremental', () => {
    const s = buildChangesScript()
    expect(s).toContain('export GIT_INDEX_FILE=/tmp/yaac-changes.idx')
    expect(s).not.toContain('$$')            // no per-run tempfile: that discards git's stat cache
    // A wedged index — including a lock orphaned by a killed run — must not
    // fail every future poll.
    expect(s).toContain('rm -f /tmp/yaac-changes.idx /tmp/yaac-changes.idx.lock; git add -A || exit 5')
  })

  // Every command feeding the file list is status-checked, and the completion
  // marker is printed only after they all pass — so a failed run surfaces as an
  // error instead of an empty changeset.
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

  // ── The script, actually executed ────────────────────────────────────────
  //
  // Everything above asserts on the script as a STRING, which cannot catch a
  // shell-semantics bug: `||` / `{ }` precedence, quoting, whether a fallback
  // really fires. The body is plain `sh` + git and touches no cluster, so run
  // it for real against scratch repos — one `sh -c` pass over the exact string
  // buildChangesScript emits, exactly as streamd invokes it. Only the two
  // pod-absolute paths are redirected; the shell body is untouched.

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
   * A repo on `main` with one commit, plus a scratch index path. The index
   * lives OUTSIDE the worktree, as it does in the pod (`/tmp`) — inside,
   * `git add -A` would stage the index itself.
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

  // THE root cause. A fork branch with no `origin/` counterpart used to fall
  // all the way through to HEAD, which hides every commit — the pane then said
  // "No changes" about a session that had plenty.
  it('resolves a fork branch that exists only locally, keeping committed work visible', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'working\n')

    // `main` exists locally; `origin/main` does not exist at all.
    const { stdout, code } = runPodScript(repo, idx, undefined, 'main')
    expect(code).toBe(0)
    const out = parseChangesOutput(stdout)
    expect(out.baseResolved).toBe(true)
    expect(out.files.map((f) => f.path).sort()).toEqual(['committed.txt', 'untracked.txt'])
    expect(out.diff).toContain('+committed')
    expect(out.diff).toContain('+working')

    // The agent's own index and HEAD are untouched by our snapshot.
    expect(git(repo, 'status', '--porcelain')).toBe('?? untracked.txt\n')
  })

  it('reports FORK 0 and only uncommitted work when no fork point resolves', () => {
    const { repo, idx } = scratchRepo()
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')

    // No remote, no upstream, and no local branch by that name either.
    const { stdout, code } = runPodScript(repo, idx, undefined, 'nowhere')
    expect(code).toBe(0)
    const out = parseChangesOutput(stdout)
    expect(out.baseResolved).toBe(false)
    // Committed work is genuinely absent — which is why the UI must not call
    // this "no changes".
    expect(out.files.map((f) => f.path)).toEqual(['dirty.txt'])
  })

  it('hard-fails on an explicit base that resolves nowhere', () => {
    const { repo, idx } = scratchRepo()
    const { code } = runPodScript(repo, idx, 'no-such-branch', 'main')
    expect(code).toBe(4) // never silently diffs against the wrong base
  })

  it('reuses the index across runs and recovers from a lock a killed run left', () => {
    const { repo, idx } = scratchRepo()
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    expect(parseChangesOutput(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['a.txt'])
    expect(fs.existsSync(idx)).toBe(true) // the index persists for the next poll

    // A second run over the reused index sees a later edit AND a deletion.
    fs.rmSync(path.join(repo, 'a.txt'))
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    expect(parseChangesOutput(runPodScript(repo, idx, undefined, 'main').stdout)
      .files.map((f) => f.path)).toEqual(['b.txt'])

    // An orphaned lock would otherwise fail every future poll.
    fs.writeFileSync(`${idx}.lock`, '')
    const recovered = runPodScript(repo, idx, undefined, 'main')
    expect(recovered.code).toBe(0)
    expect(parseChangesOutput(recovered.stdout).files.map((f) => f.path)).toEqual(['b.txt'])
    expect(fs.existsSync(`${idx}.lock`)).toBe(false)
  })
})

describe('getWorktreeChanges', () => {
  const EMPTY = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@OK@@\n@@DIFF@@\n'

  beforeEach(() => { mockExec.mockReset() })

  it('runs the pod-side script via the relay exec and parses its output', async () => {
    mockExec.mockResolvedValue({
      stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n2\t1\tsrc/x.ts\n@@NAMESTATUS@@\nM\tsrc/x.ts\n@@OK@@\n@@DIFF@@\n',
      stderr: '',
    })
    const out = await getWorktreeChanges('yaac-proj-abc')
    const [jobName, cmd, opts] = mockExec.mock.calls[0] ?? []
    expect(jobName).toBe('yaac-proj-abc')
    expect(cmd).toContain('git add -A')
    expect(cmd).toContain('GIT_INDEX_FILE')
    expect(opts).toMatchObject({ timeout: 20_000, maxAttempts: 2 })
    expect(out.base).toBe('cafe1234')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([
      { path: 'src/x.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    ])
  })

  it('forwards the chosen base branch into the pod script', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', 'dev')
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$1"')
    expect(cmd).toContain("yaac-changes 'dev' ''")
  })

  it('forwards the fork-branch default into the pod script when no explicit base', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', undefined, 'main')
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$2"')
    expect(cmd).toContain("yaac-changes '' 'main'")
  })

  // The pane polls every few seconds and each open tab polls on its own, so
  // identical concurrent requests must ride one exec rather than piling work
  // onto the pod.
  it('coalesces identical concurrent requests into a single pod exec', async () => {
    // Build the gate up front: the exec body only runs on a later microtask,
    // so a `release` captured from inside the executor would still be unset by
    // the time we open it.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    mockExec.mockImplementation(async () => {
      await gate
      return { stdout: EMPTY, stderr: '' }
    })
    const all = Promise.all([
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
    ])
    release()
    const [a, b, c] = await all
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    // A later request re-execs — the coalescing window is only "in flight".
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', undefined, 'main')
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  // Different bases are different diffs, but they share one pod-side index, so
  // they must run one at a time rather than racing on its lock.
  it('serializes differing requests for the same session', async () => {
    let running = 0
    let peak = 0
    mockExec.mockImplementation(async () => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { stdout: EMPTY, stderr: '' }
    })
    await Promise.all([
      getWorktreeChanges('yaac-proj-abc', 'dev'),
      getWorktreeChanges('yaac-proj-abc', 'main'),
      getWorktreeChanges('yaac-proj-abc', 'release'),
    ])
    expect(mockExec).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
  })

  // A pod-side failure must reach the caller as an error. Rendering it as an
  // empty changeset is the "No changes" bug.
  it('throws rather than reporting no changes when the run failed partway', async () => {
    mockExec.mockResolvedValue({ stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n', stderr: '' })
    await expect(getWorktreeChanges('yaac-proj-abc')).rejects.toThrow(/completion marker/)
  })
})

describe('worktreeForkFallback', () => {
  beforeEach(() => { mockUpstream.mockReset() })

  // The checkout's own idea of its fork point, which the server only asks for
  // when no row records one (see fork-branch.ts for why that order).
  it('reads the session branch’s upstream out of the checkout', async () => {
    mockUpstream.mockResolvedValue('main')
    expect(await worktreeForkFallback('demo', 'sid-a')).toBe('main')
    expect(mockUpstream).toHaveBeenCalledWith(repoDir('demo'), 'agent/sid-a')
  })

  // Not fatal: the pod script has its own fallback, and a worktree whose git
  // config cannot be read must not fail the whole changes request.
  it('answers null when the checkout cannot be read', async () => {
    mockUpstream.mockRejectedValue(new Error('not a git repo'))
    expect(await worktreeForkFallback('demo', 'sid-b')).toBeNull()
  })
})
