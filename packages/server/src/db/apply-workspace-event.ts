import { deleteWorkspaceAgentSessions, recordAgentSessions, setActiveAgentSessions } from './agent-session-store'
import {
  deleteWorkspaceRow,
  getWorkspaceRow,
  priorStopOf,
  recordWorkspaceCreated,
  recordWorkspaceLife,
  recordWorkspaceResumed,
  recordWorkspaceStopped,
  restoreWorkspaceStop,
  setWorkspaceBaseBranch,
  setWorkspacePermissionMode,
  type PriorStop,
} from './workspace-store'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import type { WorkspaceEvent, WorkspaceCreateFailed, WorkspaceCreated } from './events'

/**
 * The one door through which observed facts become rows: persist what an
 * observer found.
 *
 * Nothing but row writes belongs here, and the row writes it fans out to
 * live nowhere else — the per-event mutators are internal to this feature,
 * off the barrel, so a caller cannot write an observed fact except by
 * saying what happened (docs/layered-server.md).
 *
 * Being the one door also makes this the one place rows announce
 * themselves: rows are a snapshot input, so every observed fact notifies.
 * Unconditional on purpose — the hub diffs before it broadcasts, so an
 * event that changed nothing visible costs a rebuild, never a push.
 */
export async function applyWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
  await applyEvent(event)
  notifyWorkspaceListChanged()
}

async function applyEvent(event: WorkspaceEvent): Promise<void> {
  switch (event.type) {
    case 'workspace-created':
      await applyCreated(event)
      return
    case 'workspace-create-failed':
      await applyCreateFailed(event)
      return
    case 'workspace-life-started':
      // Propagates, unlike most of this fan-out: a life that was not stamped
      // leaves a dead pod's panes on the rows, and the create that emitted
      // this should fail rather than run on with them.
      await recordWorkspaceLife(event.projectSlug, event.workspaceId)
      return
    case 'base-branch-resolved':
      await setWorkspaceBaseBranch(event.projectSlug, event.workspaceId, event.baseBranch)
      return
    case 'sessions-launched': {
      const { projectSlug, workspaceId, sessions } = event
      await recordAgentSessions(projectSlug, workspaceId, sessions)
      await setActiveAgentSessions(projectSlug, workspaceId, sessions)
      return
    }
    case 'sessions-discovered':
      await recordAgentSessions(event.projectSlug, event.workspaceId, event.sessions)
      return
    case 'sessions-active':
      await setActiveAgentSessions(event.projectSlug, event.workspaceId, event.active)
      return
    case 'permission-mode-changed':
      await setWorkspacePermissionMode(event.projectSlug, event.workspaceId, event.permissionMode)
      return
    case 'workspace-stopped':
      await recordWorkspaceStopped(event.projectSlug, event.workspaceId, event.cause)
      return
  }
}

/**
 * The stop a resumed workspace's row carried before its create cleared it,
 * keyed by workspace. Read here rather than reported, because it is
 * db's own memory of a death and no observer ever sees it.
 *
 * There is no third outcome to clear an entry on — a create either fails or
 * does not — so a successful resume leaves one behind until that workspace is
 * restarted again. One `{Date, reason, detail, seen}` per workspace resumed in
 * this server's life is a bound worth accepting for not inventing a
 * success event whose only job would be freeing it.
 */
const priorStops = new Map<string, PriorStop>()

const stopKey = (projectSlug: string, workspaceId: string): string =>
  `${projectSlug}/${workspaceId}`

async function applyCreated(event: WorkspaceCreated): Promise<void> {
  const { projectSlug, workspaceId, baseBranch, resume, permissionMode, model, mode } = event
  const key = stopKey(projectSlug, workspaceId)
  // A resume is about to clear the row's deletion — remember it first, so a
  // create that then fails can put the row back rather than leaving a dead
  // workspace looking alive (or forgetting how it died). Read and cleared
  // adjacently so nothing can observe the row between the two.
  if (resume) {
    // A read failure here is not fatal — the resume proceeds — but it costs
    // the death cause a later rollback would have put back, so it says so
    // rather than looking like a workspace that simply had no stop.
    const row = await getWorkspaceRow(projectSlug, workspaceId).catch((err: unknown) => {
      serverLog(
        `[db] ${projectSlug}/${workspaceId}: could not read the prior stop `
        + `(${String(err)}); a failed resume will record a plain stop`,
      )
      return undefined
    })
    const prior = priorStopOf(row)
    if (prior) priorStops.set(key, prior)
    else priorStops.delete(key)
  }
  const launch = {
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
  }
  // A fresh create claims the id — an INSERT that refuses one already taken —
  // and a resume re-stamps the row it must already have.
  if (resume) {
    await recordWorkspaceResumed({ projectSlug, workspaceId, ...launch })
    return
  }
  await recordWorkspaceCreated({
    projectSlug,
    workspaceId,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(event.spare === true ? { spare: true } : {}),
    ...launch,
  })
}

async function applyCreateFailed(event: WorkspaceCreateFailed): Promise<void> {
  const { projectSlug, workspaceId, resume } = event
  const key = stopKey(projectSlug, workspaceId)
  const prior = priorStops.get(key)
  priorStops.delete(key)
  try {
    if (!resume) {
      // The links go with the row, and the conversations behind them: a
      // create that never came up should leave nothing, and nothing else
      // prunes either. Caught separately so a failure here cannot skip the
      // row delete below — the row is what makes the workspace visible, and
      // leaking it is far worse than leaking a conversation nothing lists.
      try {
        await deleteWorkspaceAgentSessions(projectSlug, workspaceId)
      } catch { /* best-effort */ }
      await deleteWorkspaceRow(projectSlug, workspaceId)
    } else if (prior) {
      // Exactly as the restart found it — including the cause it died of and
      // whether the user had already seen that death.
      await restoreWorkspaceStop(projectSlug, workspaceId, prior)
    } else {
      await recordWorkspaceStopped(projectSlug, workspaceId)
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
