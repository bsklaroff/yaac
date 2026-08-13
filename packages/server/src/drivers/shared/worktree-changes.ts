/**
 * The review diff for a worktree: everything the agent changed since it
 * forked from its base branch — committed, staged, unstaged and untracked —
 * as a shell script to run INSIDE the workspace, and a parser for what it
 * prints.
 *
 * Here rather than in a driver because both drivers need exactly this and
 * sealed folders may not import each other. What differs between them is
 * only where the workspace's checkout and scratch space are, which arrive
 * as parameters — the pod driver runs it over an exec into a container, the
 * host driver runs it as a local child, and neither changes a byte of the
 * script.
 *
 * The trick that makes "all of it, in one pass, without disturbing the
 * agent" work: run `git add -A` into an index of OUR OWN (GIT_INDEX_FILE),
 * then diff the base tree against that index. `add -A` brings the index to
 * the full working tree (new files staged, deleted files dropped), so `git
 * diff --cached <base>` yields every change vs the fork point — with the
 * agent's real index left untouched.
 *
 * The pane polls, so two properties matter beyond correctness of a single
 * run:
 *  - Our index lives at a stable path and is REUSED, because git's stat
 *    cache lives in the index. A per-run tempfile throws that cache away
 *    and makes every poll re-read and re-hash every tracked file.
 *  - A failed run must not be indistinguishable from an empty one. The
 *    script status-checks each command behind the file list and prints a
 *    completion marker only once they have all passed, so a partial run
 *    surfaces as an error rather than as "No changes".
 */

import type { ChangeStatus, WorktreeChange, WorktreeChanges } from '@yaac/shared/types'

/** Where one workspace's diff is computed, in the workspace's own world. */
export interface ChangesLocation {
  /** The checkout to diff. */
  workspaceDir: string
  /** Our own index file — a STABLE path, never a per-run tempfile (see the
   *  module note). Never the agent's real index. */
  indexFile: string
  /**
   * The exit code the script uses for "the base ref yielded no fork point".
   *
   * A parameter because it is contract vocabulary
   * (`CHANGES_BASE_UNRESOLVED`) and this module sits below the driver seam:
   * every driver passes the contract's constant, and the script reports
   * that code and nothing else for that failure.
   */
  baseUnresolvedCode: number
}

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

/** The in-workspace bound on the diff body, deliberately 2× the response
 *  cap: the server's cap is the authority on `truncated`, so the script's
 *  only job is to keep a pathological diff from being buffered whole and
 *  shipped back. Any diff big enough to hit this also trips the server cap
 *  first, so `truncated` stays accurate. */
const WORKSPACE_DIFF_CAP_BYTES = MAX_DIFF_BYTES * 2

const M_NUMSTAT = '@@NUMSTAT@@'
const M_NAMESTATUS = '@@NAMESTATUS@@'
/** Emitted only after every git command feeding the FILE LIST has succeeded.
 *  Its absence means the run failed partway — see parseChangesOutput. */
const M_OK = '@@OK@@'
const M_DIFF = '@@DIFF@@'

/**
 * The script body. Resolves the diff base, stages the whole working
 * tree into our own index, and prints numstat + name-status + the unified diff
 * against the base, each behind a marker. The agent's real index is never
 * touched.
 *
 * Two optional args (see buildChangesScript):
 *  - `$1` — an explicit base branch the user picked. The fork point is taken
 *    against `origin/<$1>`, then the local `<$1>`; an explicit-but-unresolvable
 *    base fails hard (exit `CHANGES_BASE_UNRESOLVED`) rather than silently
 *    diffing against the wrong base — which is also what lets the mediator
 *    answer such a request as the bad request it is.
 *  - `$2` — the branch the worktree forked from (its recorded upstream, e.g.
 *    `main`), used as the DEFAULT when no explicit base is given. The fork
 *    point is taken against `origin/<$2>`, then the local `<$2>`, then the
 *    current branch's `@{upstream}`.
 *
 * Why `$2` and not just the current branch's `@{upstream}`: once the agent
 * renames its branch and pushes it, `@{upstream}` points at that branch's OWN
 * remote (`origin/<renamed>` == HEAD), so `merge-base @{upstream} HEAD`
 * collapses to HEAD and every commit vanishes from the diff. Diffing against
 * the recorded fork branch (`origin/main`) instead keeps the real fork point.
 * The LOCAL `<$2>` is tried next because a worktree forked from a branch that
 * was never pushed has no `origin/<$2>` at all — without it such a worktree
 * falls all the way through to HEAD and reports every committed change as no
 * change.
 *
 * `FORK 1|0` reports whether a real fork point was found. `0` means we gave up
 * and diffed against HEAD, so only UNCOMMITTED work can appear — the caller
 * must not present that as "nothing changed".
 *
 * Failure is reported, never swallowed. Every command whose output feeds the
 * file list is status-checked and exits nonzero on failure, and `@@OK@@` is
 * printed only once they have all succeeded; a run that dies partway can no
 * longer reach the caller as a plausible-looking empty changeset. The diff
 * body comes last and is best-effort: the two diffs above it already proved
 * the base and index are good, and `head -c` bounds what crosses the relay.
 */
function changesScript(loc: ChangesLocation): string {
  return `cd ${loc.workspaceDir} 2>/dev/null || exit 3; `
  + 'fork=1; '
  + 'if [ -n "$1" ]; then '
  + `base=$(git merge-base "origin/$1" HEAD 2>/dev/null || git merge-base "$1" HEAD 2>/dev/null) || exit ${loc.baseUnresolvedCode}; `
  + 'elif [ -n "$2" ]; then '
  + 'base=$(git merge-base "origin/$2" HEAD 2>/dev/null || git merge-base "$2" HEAD 2>/dev/null || git merge-base @{upstream} HEAD 2>/dev/null) '
  + `|| { base=$(git rev-parse HEAD 2>/dev/null) || exit ${loc.baseUnresolvedCode}; fork=0; }; `
  + 'else '
  + 'base=$(git merge-base @{upstream} HEAD 2>/dev/null) '
  + `|| { base=$(git rev-parse HEAD 2>/dev/null) || exit ${loc.baseUnresolvedCode}; fork=0; }; `
  + 'fi; '
  // Our own index (a stable path — see ChangesLocation), reused across polls so
  // git's stat cache can make `add -A` incremental. Starting from whatever
  // snapshot the last run left, `add -A` brings it back to the full working
  // tree (new files staged, deleted files dropped), so `git diff --cached
  // <base>` still yields every change vs the fork point.
  + `export GIT_INDEX_FILE=${loc.indexFile}; `
  // A killed run (a client timeout killing the child) can leave a
  // half-written index or, worse, an orphaned `.lock` that would fail every
  // future poll. Clear both and retry once. Nothing else uses this index and
  // the server runs one of these at a time per worktree, so any lock we find
  // here belongs to a process that is already gone.
  + `git add -A || { rm -f ${loc.indexFile} ${loc.indexFile}.lock; git add -A || exit 5; }; `
  + 'printf "BASE %s\\n" "$base"; '
  + 'printf "FORK %s\\n" "$fork"; '
  + `printf "${M_NUMSTAT}\\n"; git diff --cached --numstat "$base" || exit 6; `
  + `printf "${M_NAMESTATUS}\\n"; git diff --cached --name-status "$base" || exit 6; `
  + `printf "${M_OK}\\n"; `
  + `printf "${M_DIFF}\\n"; git diff --cached "$base" 2>/dev/null | head -c ${WORKSPACE_DIFF_CAP_BYTES}; `
  + 'exit 0'
}

/** Single-quote a value for the one shell pass a driver's `exec` gives its
 *  `cmd`, so it survives as one literal argv token. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Build the `exec` command tail:
 * `sh -c <script> yaac-changes <base> <defaultBase>`.
 * The script is single-quoted for that outer shell pass; both branch args are
 * passed as the inner sh's `$1`/`$2` positionals — never interpolated into the
 * script — so any value (slashes, quotes, shell metacharacters) reaches git as
 * one literal ref token and, if bogus, simply fails to resolve. `base` is the
 * user's explicit pick (hard-fail); `defaultBase` is the worktree's fork branch
 * used gracefully when no explicit base is given. Both empty selects the bare
 * `@{upstream}`-else-HEAD default path.
 */
export function buildChangesScript(
  loc: ChangesLocation,
  base?: string,
  defaultBase?: string,
): string {
  const baseArg = shSingleQuote((base ?? '').trim())
  const defaultArg = shSingleQuote((defaultBase ?? '').trim())
  return `sh -c ${shSingleQuote(changesScript(loc))} yaac-changes ${baseArg} ${defaultArg}`
}

/** Map a git name-status letter to our ChangeStatus. */
export function statusFromCode(code: string): ChangeStatus {
  switch (code[0]) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return 'modified' // 'M' and anything unexpected
  }
}

/**
 * Resolve git's rename path notation to the destination path:
 * `{old => new}` inline segments and a bare `old => new` both collapse to the
 * "new" side.
 */
export function resolveRenamePath(raw: string): string {
  let s = raw.replace(/\{[^}]*? => ([^}]*?)\}/g, '$1')
  const arrow = s.indexOf(' => ')
  if (arrow !== -1) s = s.slice(arrow + 4)
  return s.trim()
}

/** Parse `git diff --numstat` into per-path add/delete counts (binary = -/-). */
export function parseNumstat(text: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addRaw, delRaw, ...rest] = parts
    const path = resolveRenamePath(rest.join('\t'))
    const binary = addRaw === '-' || delRaw === '-'
    out.set(path, {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    })
  }
  return out
}

/** A name-status row: the new path, its status, and (for R/C) the old path. */
type NameStatusEntry = { path: string; status: ChangeStatus; oldPath?: string }

/** Parse `git diff --name-status` into {path,status,oldPath?} (rename → new
 *  path; oldPath is the "from" side of an R/C row). */
export function parseNameStatus(text: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]
    // R/C rows are `R100\told\tnew`; everything else `M\tpath`.
    const renameOrCopy = code[0] === 'R' || code[0] === 'C'
    const path = renameOrCopy ? parts[2] : parts[1]
    if (!path) continue
    const entry: NameStatusEntry = { path, status: statusFromCode(code) }
    if (renameOrCopy && parts[1]) entry.oldPath = parts[1]
    out.push(entry)
  }
  return out
}

/** Split the marker-delimited script output into its sections. */
function section(raw: string, start: string, end?: string): string {
  const s = raw.indexOf(start)
  if (s === -1) return ''
  const from = s + start.length
  const e = end ? raw.indexOf(end, from) : -1
  return raw.slice(from, e === -1 ? undefined : e)
}

/**
 * Parse the script's output into a WorktreeChanges. name-status is the
 * authoritative file+status list; numstat supplies the counts. The diff body
 * is capped at `maxDiffBytes`.
 *
 * Throws when the `@@OK@@` marker is absent. That marker is the script's proof
 * that every command behind the file list succeeded, so without it an empty
 * `files` is indistinguishable from a run that died partway — and reporting
 * that as an empty changeset is exactly the "No changes" lie this guards.
 */
export function parseChangesOutput(raw: string, maxDiffBytes = MAX_DIFF_BYTES): WorktreeChanges {
  if (raw.indexOf(`${M_OK}\n`) === -1) {
    throw new Error('worktree changes: script produced no completion marker (partial or failed run)')
  }
  const baseMatch = /^BASE (.*)$/m.exec(raw)
  const base = baseMatch ? baseMatch[1].trim() : ''
  // FORK 0 ⇒ no fork point was resolvable and the diff is against HEAD, so
  // committed work is absent from it.
  const baseResolved = /^FORK 0$/m.exec(raw) === null

  const numstat = parseNumstat(section(raw, `${M_NUMSTAT}\n`, M_NAMESTATUS))
  const nameStatus = parseNameStatus(section(raw, `${M_NAMESTATUS}\n`, M_OK))
  const rawDiff = section(raw, `${M_DIFF}\n`).replace(/^\n/, '')

  const files: WorktreeChange[] = nameStatus.map(({ path, status, oldPath }) => {
    const counts = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false }
    const change: WorktreeChange = { path, status, additions: counts.additions, deletions: counts.deletions, binary: counts.binary }
    if (oldPath) change.oldPath = oldPath
    return change
  })

  // Measure in BYTES, not UTF-16 code units. The script's `head -c` cap is in
  // bytes, so a multi-byte diff (~3 bytes per CJK char) reaches it at well
  // under `maxDiffBytes` code units — comparing `.length` would hand back a
  // stream the script had already cut, flagged `truncated: false`. Both caps
  // are bytes, which is what makes the script cap's 2× headroom mean the
  // server's cap always trips first.
  const truncated = Buffer.byteLength(rawDiff) > maxDiffBytes
  const diff = truncated ? sliceUtf8(rawDiff, maxDiffBytes) : rawDiff

  return { base, baseResolved, files, diff, truncated }
}

/**
 * The longest prefix of `s` that fits in `maxBytes` UTF-8 bytes, cut on a code
 * point boundary. Slicing the buffer blind would split a multi-byte sequence,
 * and decoding that yields a replacement char — which both corrupts the last
 * visible line and pushes the result back OVER the cap it was enforcing.
 */
function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  // Walk back off any UTF-8 continuation byte (0b10xxxxxx) at the cut so the
  // slice ends where a sequence ends.
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

