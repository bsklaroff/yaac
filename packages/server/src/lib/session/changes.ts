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

import { containerExec } from '#lib/k8s/exec'
import type { ChangeStatus, SessionChange, SessionChanges } from '@yaac/shared/types'

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

const M_NUMSTAT = '@@NUMSTAT@@'
const M_NAMESTATUS = '@@NAMESTATUS@@'
const M_DIFF = '@@DIFF@@'

/**
 * One-line pod-side script. Resolves the fork base (merge-base with the
 * branch's upstream, else HEAD), stages the whole working tree into a temp
 * index, and prints numstat + name-status + the full unified diff against the
 * base, each behind a marker. The temp index is removed; the real one is never
 * touched.
 */
const SCRIPT = "sh -c 'cd /workspace 2>/dev/null || exit 3; "
  + 'base=$(git merge-base @{upstream} HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null) || exit 4; '
  // A FRESH (non-existent) index path — git rejects an empty mktemp file as an
  // index. $$ is the pod sh PID, unique per exec. add -A into it stages the
  // whole working tree; the agent's real index is never touched.
  + 'idx=/tmp/yaac-review-$$; rm -f "$idx"; export GIT_INDEX_FILE="$idx"; git add -A 2>/dev/null; '
  + 'printf "BASE %s\\n" "$base"; '
  + `printf "${M_NUMSTAT}\\n"; git diff --cached --numstat "$base"; `
  + `printf "${M_NAMESTATUS}\\n"; git diff --cached --name-status "$base"; `
  + `printf "${M_DIFF}\\n"; git diff --cached "$base"; `
  + "rm -f \"$idx\"'"

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

/** Compute the review diff for a running session's worktree. */
export async function getSessionChanges(jobName: string): Promise<SessionChanges> {
  const { stdout } = await containerExec(jobName, SCRIPT, { timeout: 20_000, maxAttempts: 2 })
  return parseChangesOutput(stdout)
}
