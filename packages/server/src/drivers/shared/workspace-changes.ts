/**
 * The review diff for a workspace: everything the agent changed since it
 * forked from its base branch (committed, staged, unstaged, untracked), as
 * a shell script run inside the workspace plus a parser for its output.
 * Both drivers use it unchanged; only the checkout and scratch paths differ.
 *
 * The script runs `git add -A` into a private index (GIT_INDEX_FILE), then
 * diffs the base tree against that index. This captures the whole working
 * tree without touching the agent's real index.
 *
 * Which stages each file's changes sit in comes from trees, so the working
 * tree is walked once (by `add -A`) however many stages are read: HEAD; the
 * agent's index, written as a tree from a scratch copy so the real one is
 * never written; and the private index's tree. `staged` is HEAD → the
 * agent's tree, `modified` and `untracked` are the agent's tree → the
 * working tree's (a file the agent's index lacks is untracked), and
 * `committed`, base → HEAD, is cached by that pair, since it changes only
 * when HEAD or the base moves.
 *
 * The webapp polls it, so:
 *  - The private index lives at a stable path and is reused, keeping git's
 *    stat cache so each poll does not re-hash every file.
 *  - A failed run must not look like an empty one: the script prints a
 *    completion marker only after every command behind the file list
 *    succeeds, so a partial run is an error, not "No changes".
 */

import type { ChangeStage, ChangeStatus, LineCounts, WorkspaceChange, WorkspaceChanges } from '@yaac/shared/types'

/** Where one workspace's diff is computed, as paths inside the workspace. */
export interface ChangesLocation {
  /** The checkout to diff. */
  workspaceDir: string
  /** The private index file: a stable path (see the module comment), never
   *  the agent's real index. */
  indexFile: string
  /**
   * Exit code for "the base ref has no fork point". Passed in because it is
   * the contract's `CHANGES_BASE_UNRESOLVED`, which this module cannot
   * import.
   */
  baseUnresolvedCode: number
}

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

/** In-workspace cap on the diff body, 2× the response cap. It only stops a
 *  huge diff from being buffered and sent whole; the server's cap trips
 *  first and decides `truncated`. */
const WORKSPACE_DIFF_CAP_BYTES = MAX_DIFF_BYTES * 2

const M_COMMITTED = '@@COMMITTED@@'
const M_STAGED = '@@STAGED@@'
const M_MODIFIED = '@@MODIFIED@@'
const M_UNTRACKED = '@@UNTRACKED@@'
const M_NUMSTAT = '@@NUMSTAT@@'
const M_NAMESTATUS = '@@NAMESTATUS@@'
/** Printed only after every git command feeding the file list succeeded;
 *  see parseChangesOutput. */
const M_OK = '@@OK@@'
const M_DIFF = '@@DIFF@@'

/**
 * Force-adds its arguments that still exist (a link counts, even broken),
 * in one `git add`, and nothing when none do. The names come from the
 * agent's index, so they are literal: `--` alone still lets a name like
 * `:(glob)**` or `*` match every ignored file, credentials included.
 */
const FORCE_ADD = 'for p; do shift; { [ -e "$p" ] || [ -L "$p" ]; } && set -- "$@" "$p"; done; '
  + '[ $# -eq 0 ] || exec git --literal-pathspecs add -f -- "$@"'

/**
 * The script body. Resolves the diff base, stages the working tree into the
 * private index, and prints a numstat per stage, the untracked files, then
 * numstat, name-status and the unified diff, each after a marker (see the
 * module comment for how the stages are read).
 *
 * Optional args (see buildChangesScript):
 *  - `$1`: a base branch the user picked. Tries `origin/<$1>`, then local
 *    `<$1>`. If neither resolves, exits `CHANGES_BASE_UNRESOLVED` rather than
 *    diffing against the wrong base.
 *  - `$2`: the branch the workspace forked from (e.g. `main`), the default
 *    when `$1` is empty. Tries `origin/<$2>`, local `<$2>`, then
 *    `@{upstream}`.
 *
 * `$2` is needed because after the agent renames and pushes its branch,
 * `@{upstream}` is that branch's own remote, so the merge base collapses to
 * HEAD and all commits disappear. Local `<$2>` covers a fork branch that
 * was never pushed.
 *
 * `$3`, when `nodiff`, skips the diff body: a caller that wants only the
 * file list and counts does not pay to ship every line.
 *
 * `FORK 0` means no fork point was found and the diff is against HEAD, so
 * only uncommitted work appears; callers must not present that as "nothing
 * changed".
 *
 * Every command feeding the file list is status-checked, and `@@OK@@` is
 * printed only after all succeed. The diff body comes last and is
 * best-effort, bounded by `head -c`.
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
  + 'printf "BASE %s\\n" "$base"; '
  + 'printf "FORK %s\\n" "$fork"; '
  + `c=${loc.indexFile}.committed; key="$base $(git rev-parse HEAD)"; `
  + 'if [ "$(head -n 1 "$c" 2>/dev/null)" != "$key" ]; then '
  + '{ echo "$key"; git diff --numstat "$base" HEAD; } > "$c.tmp" || exit 6; mv "$c.tmp" "$c"; fi; '
  + `printf "${M_COMMITTED}\\n"; tail -n +2 "$c"; `
  // The agent's index, copied (git swaps it in by rename, so a copy is
  // never half-written) and written as a tree. With a merge conflict it has
  // no tree, and its changes count as modified.
  + `cp "$(git rev-parse --git-path index)" ${loc.indexFile}.agent 2>/dev/null `
  + `&& agent=$(GIT_INDEX_FILE=${loc.indexFile}.agent git write-tree 2>/dev/null) `
  + '|| agent=$(git rev-parse "HEAD^{tree}") || exit 6; '
  // The stable private index lets git's stat cache make `add -A`
  // incremental across polls.
  + `export GIT_INDEX_FILE=${loc.indexFile}; `
  // A killed run can leave a half-written index or a stale `.lock` that
  // would fail every later poll. Clear both and retry once; the server runs
  // one of these at a time per workspace, so any lock here is orphaned.
  + `git add -A || { rm -f ${loc.indexFile} ${loc.indexFile}.lock; git add -A || exit 5; }; `
  // `add -A` skips a tracked file that matches .gitignore (one added with
  // `add -f`), which would then read as deleted. Force-add those the agent's
  // index tracks that are still on disk.
  + `{ [ ! -f ${loc.indexFile}.agent ] || GIT_INDEX_FILE=${loc.indexFile}.agent git ls-files -z -c -i --exclude-standard `
  + `| xargs -0 sh -c ${shSingleQuote(FORCE_ADD)} yaac-force-add; } || exit 5; `
  + 'work=$(git write-tree) || exit 5; '
  + `printf "${M_STAGED}\\n"; git diff --numstat HEAD "$agent" || exit 6; `
  + `printf "${M_MODIFIED}\\n"; git diff --numstat --no-renames --diff-filter=a "$agent" "$work" || exit 6; `
  + `printf "${M_UNTRACKED}\\n"; git diff --name-only --no-renames --diff-filter=A "$agent" "$work" || exit 6; `
  + `printf "${M_NUMSTAT}\\n"; git diff --cached --numstat "$base" || exit 6; `
  + `printf "${M_NAMESTATUS}\\n"; git diff --cached --name-status "$base" || exit 6; `
  + `printf "${M_OK}\\n"; `
  + `[ "$3" = nodiff ] || { printf "${M_DIFF}\\n"; git diff --cached "$base" 2>/dev/null | head -c ${WORKSPACE_DIFF_CAP_BYTES}; }; `
  + 'exit 0'
}

/** Single-quote a value for the one shell pass a driver's `exec` applies,
 *  so it stays one literal argv token. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Build the `exec` command tail:
 * `sh -c <script> yaac-changes <base> <defaultBase> [nodiff]`. Both branch
 * names are passed as positionals `$1`/`$2`, never interpolated into the
 * script, so any value reaches git as one literal ref (and a bogus one
 * simply fails to resolve). Both empty selects the `@{upstream}`-else-HEAD
 * default. `diff: false` adds `nodiff`, leaving the diff body out.
 */
export function buildChangesScript(
  loc: ChangesLocation,
  base?: string,
  defaultBase?: string,
  diff = true,
): string {
  const baseArg = shSingleQuote((base ?? '').trim())
  const defaultArg = shSingleQuote((defaultBase ?? '').trim())
  return `sh -c ${shSingleQuote(changesScript(loc))} yaac-changes ${baseArg} ${defaultArg}${diff ? '' : ' nodiff'}`
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
 * Parse the script's output into a WorkspaceChanges. name-status gives the
 * file list and statuses; numstat gives the counts. The diff body is capped
 * at `maxDiffBytes`.
 *
 * Throws when the `@@OK@@` marker is missing, since the run then failed
 * partway and an empty file list would falsely read as "No changes".
 */
export function parseChangesOutput(raw: string, maxDiffBytes = MAX_DIFF_BYTES): WorkspaceChanges {
  if (raw.indexOf(`${M_OK}\n`) === -1) {
    throw new Error('workspace changes: script produced no completion marker (partial or failed run)')
  }
  const baseMatch = /^BASE (.*)$/m.exec(raw)
  const base = baseMatch ? baseMatch[1].trim() : ''
  // FORK 0: no fork point, diffed against HEAD, so commits are missing.
  const baseResolved = /^FORK 0$/m.exec(raw) === null

  const byStage: [ChangeStage, Map<string, LineCounts>][] = [
    ['committed', parseNumstat(section(raw, `${M_COMMITTED}\n`, M_STAGED))],
    ['staged', parseNumstat(section(raw, `${M_STAGED}\n`, M_MODIFIED))],
    ['modified', parseNumstat(section(raw, `${M_MODIFIED}\n`, M_UNTRACKED))],
  ]
  const untracked = new Set(section(raw, `${M_UNTRACKED}\n`, M_NUMSTAT).split('\n').filter(Boolean))
  const numstat = parseNumstat(section(raw, `${M_NUMSTAT}\n`, M_NAMESTATUS))
  const nameStatus = parseNameStatus(section(raw, `${M_NAMESTATUS}\n`, M_OK))
  const rawDiff = section(raw, `${M_DIFF}\n`).replace(/^\n/, '')

  const files: WorkspaceChange[] = nameStatus.map(({ path, status, oldPath }) => {
    const { additions, deletions, binary } = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false }
    const stages: WorkspaceChange['stages'] = {}
    for (const [stage, counts] of byStage) {
      const c = counts.get(path)
      if (c) stages[stage] = { additions: c.additions, deletions: c.deletions }
    }
    if (untracked.has(path)) stages.untracked = { additions, deletions }
    const change: WorkspaceChange = { path, status, additions, deletions, binary, stages }
    if (oldPath) change.oldPath = oldPath
    return change
  })

  // Measure bytes, not UTF-16 code units: the script's `head -c` cap is in
  // bytes, so comparing `.length` could report a diff the script already
  // cut as `truncated: false`.
  const truncated = Buffer.byteLength(rawDiff) > maxDiffBytes
  const diff = truncated ? sliceUtf8(rawDiff, maxDiffBytes) : rawDiff

  return { base, baseResolved, files, diff, truncated }
}

/**
 * The longest prefix of `s` that fits in `maxBytes` UTF-8 bytes, cut on a
 * code point boundary. A blind byte slice could split a multi-byte
 * sequence, producing a replacement char that pushes the result back over
 * the cap.
 */
function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  // Step back off UTF-8 continuation bytes (0b10xxxxxx).
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

