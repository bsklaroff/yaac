import { api } from './api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import type { LaunchPane } from '#lib/store'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface CreateWorkspaceResult {
  workspaceId: string
  jobName: string
  /** The session it opened; absent for a workspace with none. */
  sessionId?: string
}

/**
 * POST a workspace create or restart and read its NDJSON progress stream.
 * Calls `onProgress` per step, then resolves with the result or throws the
 * server's error message.
 */
async function streamWorkspaceOp(
  path: string,
  body: unknown,
  onProgress: (message: string) => void,
): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // A refusal before the stream starts has the same `{error: {message}}`
    // shape as the stream's error event.
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `request failed (HTTP ${res.status})`)
  }
  return await consumeNdjsonStream<unknown>(res, onProgress)
}

/**
 * A create from the webapp: its settings, every one sent so all become the
 * project's next defaults for that agent, plus what its provisioning row
 * shows until the workspace is listed. A workspace with no session sends
 * no agent settings.
 */
export interface WorkspaceCreate {
  projectId: string
  /** Absent with `noSession`. */
  tool?: AgentTool
  mode?: AgentMode
  permissionMode?: PermissionMode
  /** Start it with no session. */
  noSession?: true
  /** Absent or empty when the provider lists no models: it launches without one. */
  model?: string
  modelName?: string
  /** Effort level, in the tool's words. */
  effort?: string
  /** The agent's opening message, typed into it once it is up. */
  prompt?: string
  /** The workspace's title, which turns off auto-titling it. */
  title?: string
  /** The row's label while it provisions, when `title` is unset. */
  shownTitle?: string
  /** Unset forks from origin's default branch. */
  branch?: string
  /** The sidebar group to file it under, by id. */
  groupId?: string
  /** A group to create and file it under, by name. */
  newGroup?: string
  /** The draft this create is made from, deleted once it has succeeded. */
  draftId?: string
  /** Minutes until the server stops it. */
  timeout?: number
  /** A pane to open once the workspace is up. */
  pane?: LaunchPane
}

export async function createWorkspace(
  workspaceId: string,
  c: WorkspaceCreate,
  onProgress: (message: string) => void,
): Promise<CreateWorkspaceResult> {
  const group = c.groupId ?? c.newGroup
  const body = {
    project: c.projectId,
    workspaceId,
    ...(c.noSession === true ? { noSession: true } : { tool: c.tool, mode: c.mode, permissionMode: c.permissionMode }),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort !== undefined ? { effort: c.effort } : {}),
    ...(c.prompt ? { prompt: c.prompt } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.branch ? { branch: c.branch } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(c.draftId !== undefined ? { draftId: c.draftId } : {}),
    ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
    // A failed create's prompt lands in the sidebar as a draft to retry from.
    draftOnFailure: true,
  }
  return await streamWorkspaceOp('/api/workspace/create', body, onProgress) as CreateWorkspaceResult
}

export async function restartWorkspace(
  workspaceId: string,
  onProgress: (message: string) => void,
): Promise<{ workspaceId: string }> {
  return await streamWorkspaceOp('/api/workspace/restart', { workspaceId }, onProgress) as { workspaceId: string }
}

/** Dismiss a failed create/restart's provisioning row. Idempotent. */
export async function dismissProvisioning(workspaceId: string): Promise<void> {
  await api.workspace.provisioning[':id'].dismiss.$post({ param: { id: workspaceId } })
}

export async function stopWorkspace(workspaceId: string): Promise<void> {
  await api.workspace.stop.$post({ json: { workspaceId } })
}

/** What a session is opened with in a running workspace; unset fields
 *  resolve as a create's. */
export interface SessionOpen {
  tool?: AgentTool
  mode?: AgentMode
  permissionMode?: PermissionMode
  model?: string
  effort?: string
  prompt?: string
  /** One of the workspace's earlier conversations to resume. */
  resume?: string
}

/** Open a session in a running workspace; resolves with its id once its
 *  window is launched. */
export async function openSession(workspaceId: string, s: SessionOpen): Promise<string> {
  const { sessionId } = await api.workspace[':id'].sessions.$post({ param: { id: workspaceId }, json: s })
  return sessionId
}

/** Close a session: its agent stops, its conversations stay as history. */
export async function closeSession(workspaceId: string, sessionId: string): Promise<void> {
  await api.workspace[':id'].sessions[':sessionId'].close.$post({ param: { id: workspaceId, sessionId } })
}

/** Relaunch a session whose agent exited. */
export async function resumeSession(workspaceId: string, sessionId: string): Promise<void> {
  await api.workspace[':id'].sessions[':sessionId'].resume.$post({ param: { id: workspaceId, sessionId } })
}

/** Set a workspace's display title; blank clears it. */
export async function renameWorkspace(workspaceId: string, title: string): Promise<void> {
  await api.workspace[':id'].title.$post({ param: { id: workspaceId }, json: { title } })
}

