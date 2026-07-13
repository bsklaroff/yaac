import { rpc, expectOk } from './rpc'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import type { AgentTool } from '@yaac/shared/types'

export interface CreateSessionResult {
  sessionId: string
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
  sessionId?: string,
): Promise<CreateSessionResult> {
  const body = sessionId ? { project, tool, sessionId } : { project, tool }
  return await streamSessionOp('/session/create', body, onProgress) as CreateSessionResult
}

export async function restartSession(
  sessionId: string,
  onProgress: (message: string) => void,
  meta?: { projectSlug?: string; tool?: AgentTool },
): Promise<{ sessionId: string }> {
  return await streamSessionOp('/session/restart', { sessionId, ...meta }, onProgress) as { sessionId: string }
}

/** Dismiss a provisioning row (drops the server registry entry; used for a
 *  failed create/restart). Idempotent server-side. */
export async function dismissProvisioning(sessionId: string): Promise<void> {
  await expectOk(rpc.session.provisioning[':id'].dismiss.$post({ param: { id: sessionId } }))
}

export async function deleteSession(sessionId: string): Promise<void> {
  await expectOk(rpc.session.delete.$post({ json: { sessionId } }))
}

/** Set a session's display title (blank clears it back to the prompt). */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await expectOk(rpc.session[':id'].title.$post({ param: { id: sessionId }, json: { title } }))
}
