import { api } from './api'
import type { AgentMode, AgentTool, PermissionMode, QueuedWorkspaceEntry } from '@yaac/shared/types'

/**
 * Queued workspaces (docs/queued-workspaces.md): create requests saved to run
 * when their parent — a workspace, or another queued entry — stops. None of
 * these are optimistic: entries ride the snapshot, so the server's push is
 * what re-renders the sidebar.
 */

/** Every setting a queued entry stores — all concrete, so what the sidebar
 *  shows is what will launch. */
export interface QueuedSettings {
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  /** Blank leaves the launched workspace to be auto-titled. */
  title: string
  /** A group id, or null for the default list. */
  group: string | null
}

/** Queue a workspace to start when `parent` (a workspace or entry id) stops.
 *  `draftId` names the draft it was made from, deleted once it is queued. */
export async function queueWorkspace(
  project: string,
  parent: string,
  settings: QueuedSettings,
  draftId?: string,
): Promise<QueuedWorkspaceEntry> {
  return await api.workspace.queue.create.$post({
    json: { project, parent, ...settings, ...(draftId !== undefined ? { draftId } : {}) },
  })
}

/** Replace an entry's settings, and its parent when `parent` is given. */
export async function updateQueuedWorkspace(
  id: string,
  patch: Partial<QueuedSettings> & { parent?: string },
): Promise<QueuedWorkspaceEntry> {
  return await api.workspace.queue.update.$post({ json: { id, ...patch } })
}

/** Delete an entry; its own queued children move up to its parent. */
export async function discardQueuedWorkspace(id: string): Promise<void> {
  await api.workspace.queue.discard.$post({ json: { id } })
}

/** Start an entry now, whatever its parent is doing. */
export async function runQueuedWorkspace(id: string): Promise<{ workspaceId: string }> {
  return await api.workspace.queue.run.$post({ json: { id } })
}
