/**
 * The review diff for a session: everything the agent changed in its worktree
 * since it forked from the base branch — committed, staged, unstaged, and
 * untracked — computed pod-side (the worktree's git metadata points at
 * container paths, so host-side git can't read it).
 *
 * The trick that makes "all of it, in one pass, without disturbing the agent"
 * work: run `git add -A` into a THROWAWAY index (GIT_INDEX_FILE=a tempfile),
 * then diff the base tree against that index. Starting from an empty temp
 * index, `add -A` reproduces the full working tree (new files staged, deleted
 * files absent), so `git diff --cached <base>` yields every change vs the fork
 * point — with the agent's real index left untouched.
 */

import { sessionExec } from '#platform/k8s'
import type { ChangeStatus, SessionChange, SessionChanges } from '@yaac/shared/types'

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

const M_NUMSTAT = '@@NUMSTAT@@'
const M_NAMESTATUS = '@@NAMESTATUS@@'
const M_DIFF = '@@DIFF@@'

/**
 * The pod-side script body. Resolves the diff base, stages the whole working
 * tree into a throwaway index, and prints numstat + name-status + the full
 * unified diff against the base, each behind a marker. The temp index is
 * removed; the real one is never touched.
 *
 * Two optional args (see buildChangesScript):
 *  - `$1` — an explicit base branch the user picked. The fork point is taken
 *    against `origin/<$1>`; an explicit-but-unresolvable base fails hard
 *    (exit 4) rather than silently diffing against the wrong base.
 *  - `$2` — the branch the session forked from (its recorded upstream, e.g.
 *    `main`), used as the DEFAULT when no explicit base is given. The fork
 *    point is taken against `origin/<$2>`, falling back gracefully to the
 *    current branch's `@{upstream}` then `HEAD`.
 *
 * Why `$2` and not just the current branch's `@{upstream}`: once the agent
 * renames its branch and pushes it, `@{upstream}` points at that branch's OWN
 * remote (`origin/<renamed>` == HEAD), so `merge-base @{upstream} HEAD`
 * collapses to HEAD and every commit vanishes from the diff. Diffing against
 * the recorded fork branch (`origin/main`) instead keeps the real fork point.
 * With neither `$1` nor `$2` set, the bare `@{upstream}`-else-HEAD path
 * remains as the last resort.
 */
const POD_SCRIPT =
  'cd /workspace 2>/dev/null || exit 3; '
  + 'if [ -n "$1" ]; then base=$(git merge-base "origin/$1" HEAD 2>/dev/null) || exit 4; '
  + 'elif [ -n "$2" ]; then base=$(git merge-base "origin/$2" HEAD 2>/dev/null || git merge-base @{upstream} HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null) || exit 4; '
  + 'else base=$(git merge-base @{upstream} HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null) || exit 4; fi; '
  // A FRESH (non-existent) index path — git rejects an empty mktemp file as an
  // index. $$ is the pod sh PID, unique per exec. add -A into it stages the
  // whole working tree; the agent's real index is never touched.
  + 'idx=/tmp/yaac-review-$$; rm -f "$idx"; export GIT_INDEX_FILE="$idx"; git add -A 2>/dev/null; '
  + 'printf "BASE %s\\n" "$base"; '
  + `printf "${M_NUMSTAT}\\n"; git diff --cached --numstat "$base"; `
  + `printf "${M_NAMESTATUS}\\n"; git diff --cached --name-status "$base"; `
  + `printf "${M_DIFF}\\n"; git diff --cached "$base"; `
  + 'rm -f "$idx"'

/** Single-quote a value for the host /bin/sh (containerExec runs its `cmd`
 *  through a shell), so it reaches kubectl as one literal argv token. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Build the containerExec command tail:
 * `sh -c <script> yaac-changes <base> <defaultBase>`.
 * The script is single-quoted for the host shell; both branch args are passed
 * as the pod sh's `$1`/`$2` positionals — never interpolated into the script —
 * so any value (slashes, quotes, shell metacharacters) reaches git as one
 * literal ref token and, if bogus, simply fails to resolve. `base` is the
 * user's explicit pick (hard-fail); `defaultBase` is the session's fork branch
 * used gracefully when no explicit base is given. Both empty selects the bare
 * `@{upstream}`-else-HEAD default path.
 */
export function buildChangesScript(base?: string, defaultBase?: string): string {
  const baseArg = shSingleQuote((base ?? '').trim())
  const defaultArg = shSingleQuote((defaultBase ?? '').trim())
  return `sh -c ${shSingleQuote(POD_SCRIPT)} yaac-changes ${baseArg} ${defaultArg}`
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

/** Split the marker-delimited pod output into its sections. */
function section(raw: string, start: string, end?: string): string {
  const s = raw.indexOf(start)
  if (s === -1) return ''
  const from = s + start.length
  const e = end ? raw.indexOf(end, from) : -1
  return raw.slice(from, e === -1 ? undefined : e)
}

/**
 * Parse the pod script's output into a SessionChanges. name-status is the
 * authoritative file+status list; numstat supplies the counts. The diff body
 * is capped at `maxDiffBytes`.
 */
export function parseChangesOutput(raw: string, maxDiffBytes = MAX_DIFF_BYTES): SessionChanges {
  const baseMatch = /^BASE (.*)$/m.exec(raw)
  const base = baseMatch ? baseMatch[1].trim() : ''

  const numstat = parseNumstat(section(raw, `${M_NUMSTAT}\n`, M_NAMESTATUS))
  const nameStatus = parseNameStatus(section(raw, `${M_NAMESTATUS}\n`, M_DIFF))
  const rawDiff = section(raw, `${M_DIFF}\n`).replace(/^\n/, '')

  const files: SessionChange[] = nameStatus.map(({ path, status, oldPath }) => {
    const counts = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false }
    const change: SessionChange = { path, status, additions: counts.additions, deletions: counts.deletions, binary: counts.binary }
    if (oldPath) change.oldPath = oldPath
    return change
  })

  const truncated = rawDiff.length > maxDiffBytes
  const diff = truncated ? rawDiff.slice(0, maxDiffBytes) : rawDiff

  return { base, files, diff, truncated }
}

/** Compute the review diff for a running session's worktree. `base`, when
 *  given, is a user-picked branch whose `origin/<base>` fork point the diff is
 *  taken against. `defaultBase` is the session's recorded fork branch (e.g.
 *  `main`), used as the default when no explicit `base` is given so committed
 *  work stays visible even after the agent renames and pushes its branch (see
 *  POD_SCRIPT). */
export async function getSessionChanges(jobName: string, base?: string, defaultBase?: string): Promise<SessionChanges> {
  const { stdout } = await sessionExec(jobName, buildChangesScript(base, defaultBase), { timeout: 20_000, maxAttempts: 2 })
  return parseChangesOutput(stdout)
}
