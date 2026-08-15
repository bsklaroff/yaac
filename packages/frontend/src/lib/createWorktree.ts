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
  if (!res.ok) throw new Error(`request failed (HTTP ${res.status})`)
  return await consumeNdjsonStream<unknown>(res, onProgress)
}

export async function createWorktree(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
  worktreeId?: string,
  branch?: string,
  mode?: AgentMode,
  /** How much the agent may do before asking. Omitted when the user did not
   *  touch the dropdown, so the server resolves it (this project's last
   *  choice, else the per-driver default) rather than the webapp guessing —
   *  and so an untouched form never overwrites the remembered choice. */
  permissionMode?: PermissionMode,
  /** Retry-only: let the server install the agent's CLI when its host hasn't
   *  got it. Set by the Install-and-retry path, never by a first attempt —
   *  yaac does not install anything the user did not ask it to. */
  installMissingTool?: boolean,
): Promise<CreateWorktreeResult> {
  const body = {
    project,
    tool,
    ...(worktreeId ? { worktreeId } : {}),
    ...(branch ? { branch } : {}),
    // Omitted for tui: the server defaults it, and sending the default would
    // make every create look like an explicit mode choice in the logs.
    ...(mode === 'acp' ? { mode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(installMissingTool === true ? { installMissingTool } : {}),
  }
  return await streamWorktreeOp('/worktree/create', body, onProgress) as CreateWorktreeResult
}

export async function restartWorktree(
  worktreeId: string,
  onProgress: (message: string) => void,
  meta?: { projectSlug?: string; tool?: AgentTool },
): Promise<{ worktreeId: string }> {
  return await streamWorktreeOp('/worktree/restart', { worktreeId, ...meta }, onProgress) as { worktreeId: string }
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
