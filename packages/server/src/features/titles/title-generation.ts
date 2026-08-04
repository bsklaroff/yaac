/**
 * Reconcile step that gives otherwise-untitled sessions a model-generated
 * title summarizing their first user message, written to the same session
 * row as a user rename — a rename simply overwrites it, and only sessions
 * with no title at all are eligible, so a user's title is never clobbered.
 *
 * Each tick fires one detached task per eligible session — the tick body
 * never blocks on a model download or inference (those serialize inside
 * the summarizer). One attempt per session per server run: the in-memory
 * `attempted` set covers in-flight dedup, failure memory, and
 * don't-regenerate after a user deliberately clears a generated title.
 */
import { listActiveSessions, notifySessionListChanged, setWorktreeTitle } from '#features/sessions'
import { shouldGenerateTitle, summarizeTitle } from './title-summarizer'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

/** Sessions already handled this server run; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const attempted = new Set<string>()

/** Sweep active sessions once, firing detached title-generation tasks. */
export async function reconcileGeneratedTitles(): Promise<void> {
  if (!env.autoTitles) return

  let worktrees
  try {
    worktrees = (await listActiveSessions()).worktrees
  } catch {
    return
  }

  for (const worktree of worktrees) {
    const { projectSlug, worktreeId, title, prompt } = worktree
    const key = `${projectSlug}:${worktreeId}`
    if (attempted.has(key)) continue
    if (title !== undefined || prompt === undefined || !shouldGenerateTitle(prompt)) continue
    attempted.add(key)
    void generateOne(projectSlug, worktreeId, prompt)
  }
}

async function generateOne(slug: string, worktreeId: string, prompt: string): Promise<void> {
  try {
    const title = await summarizeTitle(prompt)
    if (title === undefined) return
    await setWorktreeTitle(slug, worktreeId, title)
    notifySessionListChanged()
  } catch (err) {
    serverLog(`[titles] ${slug}/${worktreeId}: ${String(err)}`)
  }
}

/** Test helper: forget which sessions were already attempted. */
export function _resetTitleGenerationForTests(): void {
  attempted.clear()
}
