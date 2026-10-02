import { deleteWorkspaceAgentSessions, recordAgentSessions, setActiveAgentSessions } from './agent-session-store'
import {
  deleteWorkspaceRow,
  recordWorkspaceCreated,
  recordWorkspaceLife,
  recordWorkspaceResumed,
  recordWorkspaceStopped,
  setWorkspaceBaseBranch,
  setWorkspacePermissionMode,
} from './workspace-store'
import { notifyWorkspaceListChanged } from '#notify'
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

async function applyCreated(event: WorkspaceCreated): Promise<void> {
  const { projectSlug, workspaceId, baseBranch, resume, permissionMode, model, mode, timeZone } = event
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

/**
 * Undo a create that never came up, so it leaves nothing behind (nothing else
 * prunes these). A failed resume needs no undo: its row keeps the stop it
 * had until the restart succeeds.
 */
async function applyCreateFailed({ projectSlug, workspaceId, resume }: WorkspaceCreateFailed): Promise<void> {
  if (resume) return
  // The row first, since it is what makes the workspace visible.
  await deleteWorkspaceRow(projectSlug, workspaceId)
  await deleteWorkspaceAgentSessions(projectSlug, workspaceId)
}
