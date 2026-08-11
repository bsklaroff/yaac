import { getWorktreeRow } from '#records'
import { worktreeUpstreamBranch } from '#platform/git'
import { repoDir } from '@yaac/shared/project-paths'

/**
 * How long a worktree's fork branch is trusted without re-reading it. Reading
 * it hits the DB (and, for a worktree with no row, the checkout itself), and
 * the pane polls every few seconds — but the value is near-immutable (it is
 * written at worktree start and rewritten only by the claim-time re-branch
 * prep), so a short window costs nothing and the pane's own polling picks up a
 * rewrite well within it.
 */
const FORK_BRANCH_TTL_MS = 30_000

/** Entries are keyed per worktree and nothing tells this cache a worktree
 *  ended, so bound it: past this many, the least recently written is dropped.
 *  Far more than any install has live at once, so the eviction is a backstop
 *  against unbounded growth over a long server run, not a working-set limit. */
const FORK_BRANCH_CACHE_MAX = 256

const forkBranchCache = new Map<string, { at: number; branch: string | null }>()

/**
 * The branch a worktree forked from, cached per worktree. Returns null when
 * nothing records one — the pod script then falls back on its own.
 *
 * The worktree row is the authority, because it is OURS: it is stamped once
 * when provisioning resolves the fork branch (and again by the claim-time
 * re-branch prep) and nothing in the pod can touch it. Only when there is no
 * row does this ask the checkout for its own `branch.agent/<id>.merge`,
 * which is a fallback rather than a second source of truth — that key lives in
 * the shared repo config the agent's own git writes to, and one `git push -u
 * origin HEAD:<pr-branch>` repoints it at the branch just pushed, whose fork
 * point is HEAD. Trusting it first would report a worktree with a pushed PR as
 * having no changes at all.
 *
 * Server-side because the row is the authority and rows are the server's; the
 * fallback is one runtime call away (docs/layered-server.md).
 */
export async function worktreeForkBranch(projectSlug: string, worktreeId: string): Promise<string | null> {
  const key = `${projectSlug} ${worktreeId}`
  const hit = forkBranchCache.get(key)
  if (hit && Date.now() - hit.at < FORK_BRANCH_TTL_MS) return hit.branch
  const branch = await recordedForkBranch(projectSlug, worktreeId)
  // Re-insert on refresh too, so Map iteration order stays "oldest write first"
  // and the eviction below drops genuinely cold entries.
  forkBranchCache.delete(key)
  if (forkBranchCache.size >= FORK_BRANCH_CACHE_MAX) {
    const oldest = forkBranchCache.keys().next().value
    if (oldest !== undefined) forkBranchCache.delete(oldest)
  }
  forkBranchCache.set(key, { at: Date.now(), branch })
  return branch
}

/** The worktree row's recorded base branch, else the checkout's own upstream
 *  (see worktreeForkBranch for why that order). Either read failing is not
 *  fatal: the pod script has its own fallback. */
async function recordedForkBranch(projectSlug: string, worktreeId: string): Promise<string | null> {
  const row = await getWorktreeRow(projectSlug, worktreeId).catch(() => undefined)
  if (row?.baseBranch) return row.baseBranch
  return forkFallback(projectSlug, worktreeId).catch(() => null)
}

/** The checkout's own `branch.agent/<id>.merge`, read host-side. Not a
 *  substrate call at all — the clone is on this disk — which is why it sits
 *  beside its only caller rather than behind the runtime. */
function forkFallback(projectSlug: string, workspaceId: string): Promise<string | null> {
  return worktreeUpstreamBranch(repoDir(projectSlug), `agent/${workspaceId}`).catch(() => null)
}
