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
      await recordWorkspaceLife(event.projectId, event.workspaceId)
      return
    case 'base-branch-resolved':
      await setWorkspaceBaseBranch(event.projectId, event.workspaceId, event.baseBranch)
      return
    case 'sessions-launched': {
      const { projectId, workspaceId, sessions } = event
      await recordAgentSessions(projectId, workspaceId, sessions)
      await setActiveAgentSessions(projectId, workspaceId, sessions)
      return
    }
    case 'sessions-discovered':
      await recordAgentSessions(event.projectId, event.workspaceId, event.sessions)
      return
    case 'sessions-active':
      await setActiveAgentSessions(event.projectId, event.workspaceId, event.active)
      return
    case 'permission-mode-changed':
      await setWorkspacePermissionMode(event.projectId, event.workspaceId, event.permissionMode)
      return
    case 'workspace-stopped':
      await recordWorkspaceStopped(event.projectId, event.workspaceId, event.cause)
      return
  }
}

async function applyCreated(event: WorkspaceCreated): Promise<void> {
  const { projectId, workspaceId, baseBranch, resume, permissionMode, model, mode, timeZone } = event
  const launch = {
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  }
  // A fresh create inserts the row (refusing a taken id); a resume updates
  // the existing row.
  if (resume) {
    await recordWorkspaceResumed({ projectId, workspaceId, ...launch })
    return
  }
  await recordWorkspaceCreated({
    projectId,
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
async function applyCreateFailed({ projectId, workspaceId, resume }: WorkspaceCreateFailed): Promise<void> {
  if (resume) return
  // The row first, since it is what makes the workspace visible.
  await deleteWorkspaceRow(projectId, workspaceId)
  await deleteWorkspaceAgentSessions(projectId, workspaceId)
}
