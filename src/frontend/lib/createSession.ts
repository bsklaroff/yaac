import { api } from './apiClient'
import type { AgentTool } from '@/shared/types'

export interface CreateSessionResult {
  sessionId: string
  containerName: string
  tool: AgentTool
  claimedPrewarm: boolean
}

type StreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: { message: string } }

/**
 * POST a session operation and consume its NDJSON progress stream
 * (/session/create and /session/restart both stream
 * progress → result → error). Calls `onProgress` per step; resolves with
 * the final result object or throws the daemon's error message.
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
  if (!res.ok || !res.body) throw new Error(`request failed (HTTP ${res.status})`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: unknown = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const event = JSON.parse(line) as StreamEvent
      if (event.type === 'progress') onProgress(event.message)
      else if (event.type === 'result') result = event.result
      else if (event.type === 'error') throw new Error(event.error.message)
    }
  }

  if (result === null) throw new Error('operation returned no result')
  return result
}

export async function createSession(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
): Promise<CreateSessionResult> {
  return await streamSessionOp('/session/create', { project, tool }, onProgress) as CreateSessionResult
}

export async function restartSession(
  sessionId: string,
  onProgress: (message: string) => void,
): Promise<{ sessionId: string }> {
  return await streamSessionOp('/session/restart', { sessionId }, onProgress) as { sessionId: string }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await api.post('/session/delete', { sessionId })
}
