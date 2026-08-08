import { api } from './api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

export interface CreateSessionResult {
  worktreeId: string
  jobName: string
  tool: AgentTool
}

/**
 * POST a session operation and consume its NDJSON progress stream
 * (/session/create and /session/restart both stream
 * progress → result → error). Calls `onProgress` per step; resolves with
 * the final result object or throws the server's error message.
 */
async function streamSessionOp(
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

export async function createSession(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
  worktreeId?: string,
  branch?: string,
  mode?: AgentMode,
): Promise<CreateSessionResult> {
  const body = {
    project,
    tool,
    ...(worktreeId ? { worktreeId } : {}),
    ...(branch ? { branch } : {}),
    // Omitted for tui: the server defaults it, and sending the default would
    // make every create look like an explicit mode choice in the logs.
    ...(mode === 'acp' ? { mode } : {}),
  }
  return await streamSessionOp('/worktree/create', body, onProgress) as CreateSessionResult
}

export async function restartSession(
  worktreeId: string,
  onProgress: (message: string) => void,
  meta?: { projectSlug?: string; tool?: AgentTool },
): Promise<{ worktreeId: string }> {
  return await streamSessionOp('/worktree/restart', { worktreeId, ...meta }, onProgress) as { worktreeId: string }
}

/** Dismiss a provisioning row (drops the server registry entry; used for a
 *  failed create/restart). Idempotent server-side. */
export async function dismissProvisioning(worktreeId: string): Promise<void> {
  await api.worktree.provisioning[':id'].dismiss.$post({ param: { id: worktreeId } })
}

export async function stopWorktree(worktreeId: string): Promise<void> {
  await api.worktree.stop.$post({ json: { worktreeId } })
}

/** Set a session's display title (blank clears it back to the prompt). */
export async function renameSession(worktreeId: string, title: string): Promise<void> {
  await api.worktree[':id'].title.$post({ param: { id: worktreeId }, json: { title } })
}

/** Pin (or unpin) a session to the sidebar's "Background" section. Addressed
 *  by (project, session) rather than a container lookup so it works for
 *  deleted sessions too — the pin outlives the container. */
export async function setWorktreeBackground(
  projectSlug: string,
  worktreeId: string,
  background: boolean,
): Promise<void> {
  await api.worktree['set-background'].$post({ json: { projectSlug, worktreeId, background } })
}
