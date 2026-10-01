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
 * Persist an observed fact. This is the only way observed facts become rows:
 * the per-event mutators are off the barrel, so callers can only report what
 * happened (docs/layered-server.md).
 *
 * Every event notifies the snapshot hub. The hub diffs before broadcasting,
 * so an event that changed nothing visible costs a rebuild but no push.
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
      // Errors propagate here: if the new life isn't recorded, the rows keep
      // a dead pod's panes, so the create should fail.
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
 * The stop recorded on a resumed workspace's row before the create cleared
 * it, so a failed resume can restore it. Keyed by workspace.
 *
 * No success event clears an entry, so each successfully resumed workspace
 * leaves one small entry until its next restart. That bound is accepted
 * rather than adding an event just to free it.
 */
const priorStops = new Map<string, PriorStop>()

const stopKey = (projectSlug: string, workspaceId: string): string =>
  `${projectSlug}/${workspaceId}`

async function applyCreated(event: WorkspaceCreated): Promise<void> {
  const { projectSlug, workspaceId, baseBranch, resume, permissionMode, model, mode, timeZone } = event
  const key = stopKey(projectSlug, workspaceId)
  // A resume is about to clear the row's stop. Remember it first so a failed
  // create can restore it rather than leaving a dead workspace looking alive.
  if (resume) {
    // A read failure is not fatal, but a later rollback loses the death
    // cause, so log it.
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
    ...(timeZone !== undefined ? { timeZone } : {}),
  }
  // A fresh create inserts the row (refusing a taken id); a resume updates
  // the existing row.
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
      // A create that never came up should leave nothing behind, and nothing
      // else prunes these. Caught separately so a failure can't skip the row
      // delete, which matters more since the row makes the workspace visible.
      try {
        await deleteWorkspaceAgentSessions(projectSlug, workspaceId)
      } catch { /* best-effort */ }
      await deleteWorkspaceRow(projectSlug, workspaceId)
    } else if (prior) {
      // Restore the stop as the restart found it, including cause and seen.
      await restoreWorkspaceStop(projectSlug, workspaceId, prior)
    } else {
      await recordWorkspaceStopped(projectSlug, workspaceId)
    }
  } catch {
    // Best-effort: the create is already failing, and the reaper handles a
    // row whose pod never arrived.
  }
}

/** Test helper: forget the remembered stops. */
export function _resetPriorStopsForTests(): void {
  priorStops.clear()
}
