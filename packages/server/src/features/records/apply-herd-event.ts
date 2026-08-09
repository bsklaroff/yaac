import { deleteWorktreeAgentSessions, recordAgentSessions, setActiveAgentSessions } from './agent-session-store'
import {
  deleteWorktreeRow,
  getWorktreeRow,
  priorStopOf,
  recordWorktreeCreated,
  recordWorktreeStopped,
  restoreWorktreeStop,
  setWorktreeBaseBranch,
  type PriorStop,
} from './worktree-store'
import { serverLog } from '#log'
import type { HerdEvent, WorktreeCreateFailed, WorktreeCreated } from '@yaac/shared/herd'

/**
 * The server's end of a herd's reports (`ServerLink.workspaceEvent`):
 * persist what one found.
 *
 * Nothing but row writes belongs here. A herd reports what it *found*, and
 * the decision of which table that lands in is the server's alone — which is
 * what lets the same event arrive from a herd in another process without a
 * single call site changing.
 *
 * Wired into the link `runServer` installs (`#main/link`).
 */
export async function applyHerdEvent(event: HerdEvent): Promise<void> {
  switch (event.type) {
    case 'worktree-created':
      await applyCreated(event)
      return
    case 'worktree-create-failed':
      await applyCreateFailed(event)
      return
    case 'base-branch-resolved':
      await setWorktreeBaseBranch(event.projectSlug, event.worktreeId, event.baseBranch)
      return
    case 'conversations-launched': {
      const { projectSlug, worktreeId, conversations } = event
      await recordAgentSessions(projectSlug, worktreeId, conversations)
      await setActiveAgentSessions(projectSlug, worktreeId, conversations)
      return
    }
    case 'conversations-discovered':
      await recordAgentSessions(event.projectSlug, event.worktreeId, event.conversations)
      return
    case 'conversations-active':
      await setActiveAgentSessions(event.projectSlug, event.worktreeId, event.active)
      return
    case 'worktree-stopped':
      await recordWorktreeStopped(event.projectSlug, event.worktreeId, event.cause)
      return
  }
}

/**
 * The stop a resumed worktree's row carried before its create cleared it,
 * keyed by worktree. Read here rather than reported, because it is the
 * server's own record of a death and no herd ever sees it.
 *
 * There is no third outcome to clear an entry on — a create either fails or
 * does not — so a successful resume leaves one behind until that worktree is
 * restarted again. One `{Date, reason, detail, seen}` per worktree resumed in
 * this server's life is a bound worth accepting for not inventing a
 * success event whose only job would be freeing it.
 */
const priorStops = new Map<string, PriorStop>()

const stopKey = (projectSlug: string, worktreeId: string): string =>
  `${projectSlug}/${worktreeId}`

async function applyCreated(event: WorktreeCreated): Promise<void> {
  const { projectSlug, worktreeId, baseBranch, resume } = event
  const key = stopKey(projectSlug, worktreeId)
  // A resume is about to clear the row's deletion — remember it first, so a
  // create that then fails can put the row back rather than leaving a dead
  // worktree looking alive (or forgetting how it died). Read and cleared
  // adjacently so nothing can observe the row between the two.
  if (resume) {
    // A read failure here is not fatal — the resume proceeds — but it costs
    // the death cause a later rollback would have put back, so it says so
    // rather than looking like a worktree that simply had no stop.
    const row = await getWorktreeRow(projectSlug, worktreeId).catch((err: unknown) => {
      serverLog(
        `[herd] ${projectSlug}/${worktreeId}: could not read the prior stop `
        + `(${String(err)}); a failed resume will record a plain stop`,
      )
      return undefined
    })
    const prior = priorStopOf(row)
    if (prior) priorStops.set(key, prior)
    else priorStops.delete(key)
  }
  await recordWorktreeCreated({
    projectSlug,
    worktreeId,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  })
}

async function applyCreateFailed(event: WorktreeCreateFailed): Promise<void> {
  const { projectSlug, worktreeId, resume } = event
  const key = stopKey(projectSlug, worktreeId)
  const prior = priorStops.get(key)
  priorStops.delete(key)
  try {
    if (!resume) {
      // The links go with the row, and the conversations behind them: a
      // create that never came up should leave nothing, and nothing else
      // prunes either. Caught separately so a failure here cannot skip the
      // row delete below — the row is what makes the worktree visible, and
      // leaking it is far worse than leaking a conversation nothing lists.
      try {
        await deleteWorktreeAgentSessions(projectSlug, worktreeId)
      } catch { /* best-effort */ }
      await deleteWorktreeRow(projectSlug, worktreeId)
    } else if (prior) {
      // Exactly as the restart found it — including the cause it died of and
      // whether the user had already seen that death.
      await restoreWorktreeStop(projectSlug, worktreeId, prior)
    } else {
      await recordWorktreeStopped(projectSlug, worktreeId)
    }
  } catch {
    // Best-effort: the create is already failing, and the reaper records a
    // row whose pod never arrived.
  }
}

/** Test helper: forget the remembered stops. */
export function _resetPriorStopsForTests(): void {
  priorStops.clear()
}
