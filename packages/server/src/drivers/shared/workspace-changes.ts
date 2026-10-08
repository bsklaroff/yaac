/**
 * The review diff for a workspace: everything the agent changed since it
 * forked from its base branch (committed, staged, unstaged, untracked), as
 * a shell script run inside the workspace plus a parser for its output.
 * Both drivers use it unchanged; only the checkout and scratch paths differ.
 * The same run also says how far HEAD is from the base branch and, when
 * asked, lists the checkout for the file explorer, so the webapp polls one
 * thing per workspace.
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

import { CHANGES_BASE_UNRESOLVED, CHANGES_BUSY, type ChangesReading, type ChangesRequest } from '#drivers/contract'
import type { ChangeStage, ChangeStatus, LineCounts, WorkspaceChange } from '@yaac/shared/types'

/** Where one workspace's diff is computed, as paths inside the workspace. */
export interface ChangesLocation {
  /** The checkout to diff. */
  workspaceDir: string
  /** The private index file: a stable path (see the module comment), never
   *  the agent's real index. */
  indexFile: string
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
/** Always printed after name-status. The listing's sections follow it,
 *  each NUL-separated and ended by `END`, since a path may hold a newline. */
const M_LISTING = '@@LISTING@@'
const M_PATHS = '@@PATHS@@'
const M_CONFLICTED = '@@CONFLICTED@@'
const M_IGNORED = '@@IGNORED@@'
const M_DIRS = '@@DIRS@@'
const END = '@@END@@'
/** `END` framed by NULs, as a printf format. */
const nulEnd = `\\000${END}\\000`
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
 * Args (see buildChangesScript):
 *  - `$1`: a base branch the user picked. Tries `origin/<$1>`, then local
 *    `<$1>`. If neither resolves, exits `CHANGES_BASE_UNRESOLVED` rather than
 *    diffing against the wrong base.
 *  - `$2`: the branch the workspace forked from (e.g. `main`), the default
 *    when `$1` is empty. Tries `origin/<$2>`, local `<$2>`, then
 *    `@{upstream}`.
 *  - `$3`: `diff`, or `nodiff` to skip the diff body, so a caller that
 *    wants only the file list and counts does not pay to ship every line.
 *  - `$4`: empty, `paths` or `full`: which listing to print.
 *
 * `$2` is needed because after the agent renames and pushes its branch,
 * `@{upstream}` is that branch's own remote, so the merge base collapses to
 * HEAD and all commits disappear. Local `<$2>` covers a fork branch that
 * was never pushed.
 *
 * `REF` names the ref the base was found on and how far HEAD is behind and
 * ahead of it, for the status bar.
 *
 * The listing's paths come from the private index after `add -A`, so they
 * cost no second walk: every file git does not ignore, links marked by
 * their mode. Ignored entries and untracked folders do walk the tree, so
 * only `full` reads them. Conflicts come from the agent's index.
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
  // One run at a time per workspace, even past the server's mutex: a run
  // whose exec timed out keeps going in the workspace, holding the private
  // index. The run lock holds its pid, made by an atomic `ln`. A live
  // holder is waited for (its run warms the index) for up to 10 seconds,
  // then the run gives up with CHANGES_BUSY. A dead holder's lock is
  // cleared, and so is one over two minutes old, whose pid may since
  // belong to an unrelated process.
  + `lk=${loc.indexFile}.run; echo $$ > "$lk.$$"; w=0; `
  + 'while ! ln "$lk.$$" "$lk" 2>/dev/null; do '
  + 'p=$(cat "$lk" 2>/dev/null); '
  + 'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && [ -z "$(find "$lk" -mmin +2 2>/dev/null)" ]; then '
  + `w=$((w+1)); [ $w -le 50 ] || { rm -f "$lk.$$"; exit ${CHANGES_BUSY}; }; sleep 0.2; `
  + 'else rm -f "$lk"; fi; done; '
  + 'rm -f "$lk.$$"; trap \'rm -f "$lk"\' EXIT; '
  + 'ref=; fork=1; '
  + 'if [ -n "$1" ]; then '
  + 'for r in "origin/$1" "$1"; do base=$(git merge-base "$r" HEAD 2>/dev/null) && { ref=$r; break; }; done; '
  + `[ -n "$ref" ] || exit ${CHANGES_BASE_UNRESOLVED}; `
  + 'elif [ -n "$2" ]; then '
  + 'for r in "origin/$2" "$2" "@{upstream}"; do base=$(git merge-base "$r" HEAD 2>/dev/null) && { ref=$r; break; }; done; '
  + `[ -n "$ref" ] || { base=$(git rev-parse HEAD 2>/dev/null) || exit ${CHANGES_BASE_UNRESOLVED}; fork=0; }; `
  + 'else '
  + 'base=$(git merge-base @{upstream} HEAD 2>/dev/null) && ref=@{upstream} '
  + `|| { base=$(git rev-parse HEAD 2>/dev/null) || exit ${CHANGES_BASE_UNRESOLVED}; fork=0; }; `
  + 'fi; '
  + 'printf "BASE %s\\n" "$base"; '
  + 'printf "FORK %s\\n" "$fork"; '
  + '[ "$ref" != "@{upstream}" ] || ref=$(git rev-parse --abbrev-ref "@{upstream}"); '
  + '[ -z "$ref" ] || { n=$(git rev-list --left-right --count "$ref...HEAD" --) && printf "REF %s %s\\n" "$ref" "$n"; }; '
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
  // A missing private index starts as a copy of the agent's, whose stat
  // data spares `add -A` hashing every file on a workspace's first poll.
  // It compares only mtime and size (`core.checkStat=minimal`): the server
  // writes a new checkout's index, and a pod sees other inode numbers, so
  // under the default check every seeded entry would look changed.
  // `--ignore-errors` adds what it can past an entry git cannot index (a
  // nested repo with no commit), exiting 1, so one such entry costs the
  // diff and the listing only that entry. Anything else is a stale `.lock`
  // or a broken index a killed run left, which would fail every later poll:
  // clear both and retry once. The run lock means no live run holds them.
  + `seed() { [ -f ${loc.indexFile} ] || cp ${loc.indexFile}.agent ${loc.indexFile} 2>/dev/null; }; `
  + 'add() { git -c core.checkStat=minimal add -A --ignore-errors || [ $? -eq 1 ]; }; '
  + `seed; add || { rm -f ${loc.indexFile} ${loc.indexFile}.lock; seed; add || exit 5; }; `
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
  + `printf "${M_LISTING}\\n"; `
  + 'if [ -n "$4" ]; then '
  + `printf "${M_PATHS}\\n"; git ls-files -z -s || exit 6; printf '${nulEnd}'; `
  + `printf "${M_CONFLICTED}\\n"; { [ ! -f ${loc.indexFile}.agent ] `
  + `|| GIT_INDEX_FILE=${loc.indexFile}.agent git ls-files -z -u; } || exit 6; printf '${nulEnd}'; `
  + 'fi; '
  + 'if [ "$4" = full ]; then '
  + `printf "${M_IGNORED}\\n"; git ls-files -z --others --ignored --exclude-standard --directory || exit 6; printf '${nulEnd}'; `
  + `printf "${M_DIRS}\\n"; git ls-files -z --others --exclude-standard --directory || exit 6; printf '${nulEnd}'; `
  + 'fi; '
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
 * `sh -c <script> yaac-changes <base> <defaultBase> <diff|nodiff> <listing>`.
 * Both branch names are passed as positionals, never interpolated into the
 * script, so any value reaches git as one literal ref (and a bogus one
 * simply fails to resolve). Both empty selects the `@{upstream}`-else-HEAD
 * default.
 */
export function buildChangesScript(loc: ChangesLocation, request: ChangesRequest): string {
  return `sh -c ${shSingleQuote(changesScript(loc))} yaac-changes `
    + [request.base, request.defaultBase].map((b) => shSingleQuote((b ?? '').trim())).join(' ')
    + ` ${request.diff ? 'diff' : 'nodiff'} ${request.listing ?? "''"}`
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

/** The entries of a NUL-separated listing section; null when it was not
 *  printed. */
function nulSection(raw: string, marker: string): string[] | null {
  const s = raw.indexOf(`${marker}\n`)
  if (s === -1) return null
  const from = s + marker.length + 1
  const e = raw.indexOf(`\0${END}\0`, from)
  return raw.slice(from, e === -1 ? undefined : e).split('\0').filter(Boolean)
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
 * Parse the script's output. name-status gives the file list and statuses;
 * numstat gives the counts. The diff body is capped at `maxDiffBytes`.
 *
 * Throws when the `@@OK@@` marker is missing, since the run then failed
 * partway and an empty file list would falsely read as "No changes".
 */
export function parseChangesOutput(raw: string, maxDiffBytes = MAX_DIFF_BYTES): ChangesReading {
  const ok = raw.indexOf(`${M_OK}\n`)
  if (ok === -1) {
    throw new Error('workspace changes: script produced no completion marker (partial or failed run)')
  }
  // Everything but the diff body comes before the marker; the body is file
  // content, so nothing else is looked for in it.
  const head = raw.slice(0, ok)
  const baseMatch = /^BASE (.*)$/m.exec(head)
  const base = baseMatch ? baseMatch[1].trim() : ''
  // FORK 0: no fork point, diffed against HEAD, so commits are missing.
  const baseResolved = /^FORK 0$/m.exec(head) === null

  const byStage: [ChangeStage, Map<string, LineCounts>][] = [
    ['committed', parseNumstat(section(head, `${M_COMMITTED}\n`, M_STAGED))],
    ['staged', parseNumstat(section(head, `${M_STAGED}\n`, M_MODIFIED))],
    ['modified', parseNumstat(section(head, `${M_MODIFIED}\n`, M_UNTRACKED))],
  ]
  const untracked = new Set(section(head, `${M_UNTRACKED}\n`, M_NUMSTAT).split('\n').filter(Boolean))
  const numstat = parseNumstat(section(head, `${M_NUMSTAT}\n`, M_NAMESTATUS))
  const nameStatus = parseNameStatus(section(head, `${M_NAMESTATUS}\n`, M_LISTING))

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

  // The marker is printed only when the body was asked for. Measure bytes,
  // not UTF-16 code units: the script's `head -c` cap is in bytes, so
  // comparing `.length` could report a diff the script already cut as
  // `truncated: false`.
  const rawDiff = raw.includes(`${M_DIFF}\n`, ok) ? section(raw.slice(ok), `${M_DIFF}\n`).replace(/^\n/, '') : undefined
  const truncated = rawDiff !== undefined && Buffer.byteLength(rawDiff) > maxDiffBytes
  const diff = truncated ? sliceUtf8(rawDiff, maxDiffBytes) : rawDiff

  // `REF <ref> <behind>\t<ahead>`: rev-list counts the left side first.
  const refMatch = /^REF (\S+) (\d+)\s+(\d+)$/m.exec(head)
  const ref = refMatch ? { name: refMatch[1], behind: Number(refMatch[2]), ahead: Number(refMatch[3]) } : null

  const staged = nulSection(head, M_PATHS)
  let listing: ChangesReading['listing']
  if (staged) {
    // `<mode> <object> <stage>\t<path>`; a link's mode is 120000.
    const entries = staged.map((e) => ({ mode: e.slice(0, 6), path: e.slice(e.indexOf('\t') + 1) }))
    const ignored = nulSection(head, M_IGNORED)
    const dirs = nulSection(head, M_DIRS)
    listing = {
      paths: entries.map((e) => e.path),
      links: entries.filter((e) => e.mode === '120000').map((e) => e.path),
      // One entry per conflict stage.
      conflicted: [...new Set((nulSection(head, M_CONFLICTED) ?? []).map((e) => e.slice(e.indexOf('\t') + 1)))],
      ...(ignored ? { ignored } : {}),
      ...(dirs ? { untrackedDirs: dirs.filter((d) => d.endsWith('/')).map((d) => d.slice(0, -1)) } : {}),
    }
  }

  return {
    changes: { base, baseResolved, files, ...(diff !== undefined ? { diff } : {}), truncated },
    ref,
    ...(listing ? { listing } : {}),
  }
}

/** A read of one workspace's changes, queued or running. */
interface ChangesRun {
  request: ChangesRequest
  started: boolean
  result: Promise<ChangesReading>
}

/** Per workspace, its running read first, then the ones queued behind it. */
const changesRuns = new Map<string, ChangesRun[]>()

const LISTING_RANK = { undefined: 0, paths: 1, full: 2 } as const
const listingRank = (r: ChangesRequest): number => LISTING_RANK[r.listing ?? 'undefined']

/**
 * Run `read` for a workspace's changes, one read at a time, sharing reads
 * between requests. The reads share one git index in the workspace, so
 * they cannot overlap, and each walks the whole working tree, which is
 * slow on a network filesystem. A request against the same base therefore
 * joins a read still queued, widening what it asks for, rather than
 * queuing one of its own. It never joins the running read: that read
 * started before the request arrived, so it could miss an edit the caller
 * just made. Every caller gets back only the parts it asked for.
 */
export function runChangesRead(
  jobName: string,
  request: ChangesRequest,
  read: (request: ChangesRequest) => Promise<ChangesReading>,
): Promise<ChangesReading> {
  const runs = changesRuns.get(jobName) ?? []
  let run = runs.find((r) => !r.started
    && (r.request.base ?? '') === (request.base ?? '') && (r.request.defaultBase ?? '') === (request.defaultBase ?? ''))
  if (run) {
    run.request = {
      ...run.request,
      diff: run.request.diff || request.diff,
      listing: listingRank(request) > listingRank(run.request) ? request.listing : run.request.listing,
    }
  }
  if (!run) {
    const before = runs.at(-1)?.result
    const queued = { request, started: false } as ChangesRun
    queued.result = (async () => {
      await before?.catch(() => undefined)
      queued.started = true
      try {
        return await read(queued.request)
      } finally {
        runs.splice(runs.indexOf(queued), 1)
        if (runs.length === 0) changesRuns.delete(jobName)
      }
    })()
    runs.push(queued)
    changesRuns.set(jobName, runs)
    run = queued
  }
  return run.result.then((reading) => answerFor(reading, request))
}

/** `reading` cut down to what `request` asked for. */
function answerFor(reading: ChangesReading, request: ChangesRequest): ChangesReading {
  const { diff: _diff, ...bare } = reading.changes
  const { listing, ...rest } = reading
  const cut = listing && request.listing === 'paths'
    ? { paths: listing.paths, links: listing.links, conflicted: listing.conflicted }
    : request.listing && listing
  return {
    ...rest,
    changes: request.diff ? reading.changes : { ...bare, truncated: false },
    ...(cut ? { listing: cut } : {}),
  }
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
