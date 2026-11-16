import {
  recordConversationCaptures,
  recordConversations,
  setActiveConversations,
} from './conversation-store'
import {
  recordWorkspaceCreated,
  recordWorkspaceLaunched,
  recordWorkspaceLife,
  recordIgnoredFilesCleaned,
  recordLifeCheckpointed,
  recordLifeNode,
  recordWorkspaceStopped,
  removeWorkspaceLivesAfter,
  removeWorkspaceRecords,
  setWorkspaceStepsOutcome,
  setWorkspaceTrackedScratchDirs,
} from './workspace-store'
import { recordStepChange, startLifeSteps } from './step-store'
import { setWorkspaceRepoStart } from './repo-store'
import { closeSessionRow, recordSessionReport, recordSessionWaitingUnseen } from './session-store'
import { markVolumesPinned, releaseVolume } from './volume-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import type { WorkspaceEvent, WorkspaceCreateFailed } from './events'

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
    case 'workspace-created': {
      const at = event.at ?? new Date()
      await recordWorkspaceCreated({ ...event, at })
      await startLifeSteps(event.projectId, event.workspaceId, at, event.startSteps ?? [], event.skipped)
      return
    }
    case 'workspace-create-failed':
      await applyCreateFailed(event)
      return
    case 'workspace-life-started':
      await recordWorkspaceLife(event.projectId, event.workspaceId, event)
      await startLifeSteps(event.projectId, event.workspaceId, event.at, event.startSteps, event.skipped)
      return
    case 'workspace-launched':
      await recordWorkspaceLaunched(event.projectId, event.workspaceId)
      return
    case 'start-commit-resolved':
      await setWorkspaceRepoStart(event.workspaceId, event.repoId, { startCommit: event.startCommit })
      return
    case 'step-changed':
      await recordStepChange(event.workspaceId, event.life, { workflowName: event.workflowName, name: event.name }, {
        state: event.state,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      })
      return
    case 'steps-settled':
      await setWorkspaceStepsOutcome(event.projectId, event.workspaceId, event.outcome)
      return
    case 'base-branch-resolved':
      await setWorkspaceRepoStart(event.workspaceId, event.repoId, { baseBranch: event.baseBranch })
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
    case 'life-node-found':
      await recordLifeNode(event.projectId, event.workspaceId, event.node)
      return
    case 'life-checkpointed':
      await recordLifeCheckpointed(event.workspaceId, event.life, event.outcome, event.detail)
      return
    case 'volume-released':
      await releaseVolume(event.volumeId, event.lease)
      return
    case 'volumes-pinned':
      await markVolumesPinned(event.volumeIds)
      return
  }
}

/**
 * Undo a create that never came up, so it leaves nothing behind (nothing else
 * prunes these). A failed restart keeps the workspace and loses only the
 * life it had started, if it got that far.
 */
async function applyCreateFailed({ projectId, workspaceId, lifeBefore }: WorkspaceCreateFailed): Promise<void> {
  if (lifeBefore === undefined) await removeWorkspaceRecords(projectId, workspaceId)
  else await removeWorkspaceLivesAfter(workspaceId, lifeBefore)
}
