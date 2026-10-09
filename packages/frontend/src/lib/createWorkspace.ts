import { api } from './api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface CreateWorkspaceResult {
  workspaceId: string
  jobName: string
  tool: AgentTool
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

/** Optional create settings. The server fills an omitted field from what
 *  this project last used, else a fallback. Only fields sent become the
 *  project's next defaults. */
export interface CreateWorkspaceOptions {
  branch?: string
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  /** Effort level, in the tool's words. */
  effort?: string
  /** The agent's opening message, typed into it once it is up. */
  prompt?: string
  /** The workspace's title, which turns off auto-titling it. */
  title?: string
  /** The sidebar group to file it under, by id. */
  group?: string
  /** The draft this create is made from, deleted once it has succeeded. */
  draftId?: string
}

export async function createWorkspace(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
  workspaceId?: string,
  opts: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceResult> {
  const body = {
    project,
    tool,
    ...(workspaceId ? { workspaceId } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.group !== undefined ? { group: opts.group } : {}),
    ...(opts.draftId !== undefined ? { draftId: opts.draftId } : {}),
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

/** Set a workspace's display title; blank clears it. */
export async function renameWorkspace(workspaceId: string, title: string): Promise<void> {
  await api.workspace[':id'].title.$post({ param: { id: workspaceId }, json: { title } })
}
