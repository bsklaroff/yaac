import type { AgentTool } from '@/shared/types'

export interface CreateSessionResult {
  sessionId: string
  containerName: string
  tool: AgentTool
  claimedPrewarm: boolean
}

type CreateEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: CreateSessionResult }
  | { type: 'error'; error: { message: string } }

/**
 * POST /session/create and consume its NDJSON progress stream. Calls
 * `onProgress` for each step and resolves with the final result, or
 * throws with the daemon's error message.
 */
export async function createSession(
  project: string,
  tool: AgentTool,
  onProgress: (message: string) => void,
): Promise<CreateSessionResult> {
  const res = await fetch('/session/create', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, tool }),
  })
  if (!res.ok || !res.body) throw new Error(`create failed (HTTP ${res.status})`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: CreateSessionResult | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const event = JSON.parse(line) as CreateEvent
      if (event.type === 'progress') onProgress(event.message)
      else if (event.type === 'result') result = event.result
      else if (event.type === 'error') throw new Error(event.error.message)
    }
  }

  if (!result) throw new Error('session creation returned no result')
  return result
}
