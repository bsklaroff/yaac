import {
  recordConversationCaptures,
  recordConversations,
  setActiveConversations,
} from './conversation-store'
import {
  recordWorkspaceCreated,
  recordWorkspaceLife,
  recordWorkspaceResumed,
  recordIgnoredFilesCleaned,
  recordWorkspaceStopped,
  removeWorkspaceRecords,
  setWorkspaceBaseBranch,
  setWorkspaceTrackedScratchDirs,
} from './workspace-store'
import { closeSessionRow, recordSessionReport, recordSessionWaitingUnseen } from './session-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
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
    case 'tracked-scratch-dirs-found':
      await setWorkspaceTrackedScratchDirs(event.projectId, event.workspaceId, event.paths)
      return
    case 'conversations-discovered':
      await recordConversations(event.projectId, event.workspaceId, event.sessions)
      return
    case 'conversations-captured':
      await recordConversationCaptures(event.projectId, event.sessions)
      return
    case 'conversations-active':
      await setActiveConversations(event.projectId, event.workspaceId, event.active)
      return
    case 'session-reported':
      await recordSessionReport(event.sessionId, event)
      return
    case 'session-window-gone':
      await closeSessionRow(event.sessionId)
      return
    case 'waiting-ended':
      await recordSessionWaitingUnseen(event.workspaceId, event.window)
      return
    case 'workspace-stopped':
      await recordWorkspaceStopped(event.projectId, event.workspaceId, event.cause)
      return
    case 'ignored-files-cleaned':
      await recordIgnoredFilesCleaned(event.projectId, event.workspaceId, event.at)
      return
  }
}

async function applyCreated(event: WorkspaceCreated): Promise<void> {
  const { projectId, workspaceId, baseBranch, title, generatedTitle, groupId, resume, timeZone, deadline, scratchDirs } = event
  const launch = {
    ...(deadline !== undefined ? { deadline } : {}),
    ...(scratchDirs !== undefined ? { scratchDirs } : {}),
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
    ...(title !== undefined ? { title } : {}),
    ...(generatedTitle !== undefined ? { generatedTitle } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
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
  await removeWorkspaceRecords(projectId, workspaceId)
}
