import { api } from './api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface CreateWorktreeResult {
  worktreeId: string
  jobName: string
  tool: AgentTool
}

/**
 * POST a worktree operation and consume its NDJSON progress stream
 * (/worktree/create and /worktree/restart both stream
 * progress → result → error). Calls `onProgress` per step; resolves with
 * the final result object or throws the server's error message.
 */
async function streamWorktreeOp(
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
    // A refusal before the stream (unknown worktree, an id already in use)
    // carries the same `{error: {message}}` the stream's error event does.
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `request failed (HTTP ${res.status})`)
  }
  return await consumeNdjsonStream<unknown>(res, onProgress)
}

/** What a create names beyond its project and tool. Each field left out is
 *  resolved server-side — from what this project last used, else a fallback
 *  — and only the fields sent become the project's next defaults. */
export interface CreateWorktreeOptions {
  branch?: string
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  /** The agent's opening message, typed into it once it is up. */
  prompt?: string
  /** The draft this create is made from, deleted once it has succeeded. */
  draftId?: string
}

export async function createWorktree(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
  worktreeId?: string,
  opts: CreateWorktreeOptions = {},
): Promise<CreateWorktreeResult> {
  const body = {
    project,
    tool,
    ...(worktreeId ? { worktreeId } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.draftId !== undefined ? { draftId: opts.draftId } : {}),
  }
  return await streamWorktreeOp('/worktree/create', body, onProgress) as CreateWorktreeResult
}

export async function restartWorktree(
  worktreeId: string,
  onProgress: (message: string) => void,
): Promise<{ worktreeId: string }> {
  return await streamWorktreeOp('/worktree/restart', { worktreeId }, onProgress) as { worktreeId: string }
}

/** Dismiss a provisioning row (drops the server registry entry; used for a
 *  failed create/restart). Idempotent server-side. */
export async function dismissProvisioning(worktreeId: string): Promise<void> {
  await api.worktree.provisioning[':id'].dismiss.$post({ param: { id: worktreeId } })
}

export async function stopWorktree(worktreeId: string): Promise<void> {
  await api.worktree.stop.$post({ json: { worktreeId } })
}

/** Set a worktree's display title (blank clears it back to the prompt). */
export async function renameWorktree(worktreeId: string, title: string): Promise<void> {
  await api.worktree[':id'].title.$post({ param: { id: worktreeId }, json: { title } })
}
