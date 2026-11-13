import type { BranchComparison, LineCounts } from '@yaac/shared/types'

/**
 * The git status bar's last answer for each workspace, kept in localStorage
 * so a reload shows it at once rather than an empty bar until the first
 * changes read lands, which can take seconds. The desktop and iOS shells
 * reload the page on every server switch, and localStorage is per origin,
 * so each server keeps its own. Only the workspaces whose status changed
 * most recently are kept.
 */
export interface GitStatusSummary {
  branch: string | null
  comparison: BranchComparison | null
  /** The changed lines in all; null when no file differs. */
  counts: LineCounts | null
  /** The checkout this describes (`useCheckout`'s `repo`): absent for a
   *  workspace's only one. */
  repo?: string
}

const KEY = 'yaac.gitstatus.v1'
const MAX_KEPT = 100

function load(): Record<string, GitStatusSummary> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, GitStatusSummary> : {}
  } catch {
    return {}
  }
}

/** The last status saved for a workspace, if it looks like one. */
export function lastGitStatus(workspaceId: string): GitStatusSummary | undefined {
  const s = load()[workspaceId] as Partial<GitStatusSummary> | undefined
  const objectOrNull = (v: unknown): boolean => v === null || (typeof v === 'object' && !Array.isArray(v))
  return s && (s.branch === null || typeof s.branch === 'string') && objectOrNull(s.comparison) && objectOrNull(s.counts)
    && (s.repo === undefined || typeof s.repo === 'string')
    ? s as GitStatusSummary
    : undefined
}

/** Save a workspace's status, moving it to the newest end. */
export function saveGitStatus(workspaceId: string, summary: GitStatusSummary): void {
  const all = load()
  if (JSON.stringify(all[workspaceId]) === JSON.stringify(summary)) return
  delete all[workspaceId]
  const kept = Object.entries(all).slice(1 - MAX_KEPT)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...kept, [workspaceId, summary]])))
  } catch { /* storage blocked or over quota: the bar starts empty after a reload */ }
}
