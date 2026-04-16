import fs from 'node:fs/promises'
import { codexTranscriptFile } from '@/lib/project/paths'
import { scanJsonlForward } from '@/lib/session/jsonl'

interface CodexEntry {
  type: string
  payload?: {
    type?: string
    message?: string
    role?: string
    name?: string
    call_id?: string
    phase?: string
  }
  item?: {
    type?: string
    status?: string
  }
}

const CHUNK_SIZE = 4096

function getUserMessageText(entry: CodexEntry): string | undefined {
  if (entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string' && entry.payload.message.length > 0) {
    return entry.payload.message
  }
  return undefined
}

function getCodexEntryStatus(
  entry: CodexEntry,
  resolvedCalls: Set<string>,
): 'running' | 'waiting' | 'continue' {
  if (entry.type === 'response_item') {
    if (entry.payload?.type === 'function_call_output') {
      if (entry.payload.call_id) resolvedCalls.add(entry.payload.call_id)
      return 'continue'
    }

    if (entry.payload?.type === 'function_call') {
      const callId = entry.payload.call_id
      if (callId && resolvedCalls.has(callId)) {
        resolvedCalls.delete(callId)
        return 'continue'
      }
      return entry.payload.name === 'request_user_input' ? 'waiting' : 'running'
    }

    if (entry.payload?.type === 'message') {
      if (entry.payload.role === 'assistant' && entry.payload.phase === 'final_answer') return 'waiting'
      if (entry.payload.role === 'user') return 'running'
    }

    return 'continue'
  }

  if (entry.type === 'event_msg') {
    if (entry.payload?.type === 'user_message' || entry.payload?.type === 'task_started') return 'running'
    if (entry.payload?.type === 'task_complete' || entry.payload?.type === 'turn_aborted') {
      return 'waiting'
    }
    if (entry.payload?.type === 'agent_message' && entry.payload.phase === 'final_answer') return 'waiting'
  }

  return 'continue'
}

/**
 * Reads lines from the end of a Codex JSONL session log and determines
 * whether Codex is actively working or waiting for user input.
 *
 * Codex JSONL uses event types like turn.started, turn.completed,
 * item.started, item.completed, and event_msg (user input).
 */
export async function getCodexStatus(jsonlPath: string): Promise<'running' | 'waiting'> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return 'waiting'

    let offset = stat.size
    let carryover = ''
    const resolvedCalls = new Set<string>()

    while (offset > 0) {
      const chunkSize = Math.min(offset, CHUNK_SIZE)
      offset -= chunkSize
      const buf = Buffer.alloc(chunkSize)
      await handle.read(buf, 0, chunkSize, offset)

      const raw = buf.toString('utf8') + carryover
      const parts = raw.split('\n')

      carryover = parts[0]

      for (let i = parts.length - 1; i >= 1; i--) {
        const line = parts[i].trim()
        if (line.length === 0) continue

        let entry: CodexEntry
        try {
          entry = JSON.parse(line) as CodexEntry
        } catch {
          continue
        }

        const status = getCodexEntryStatus(entry, resolvedCalls)
        if (status !== 'continue') return status
      }
    }

    // Process the final carryover
    if (carryover.trim().length > 0) {
      try {
        const entry = JSON.parse(carryover) as CodexEntry
        const status = getCodexEntryStatus(entry, resolvedCalls)
        if (status !== 'continue') return status
      } catch {
        // ignore
      }
    }

    // Could not determine — assume waiting (session just started)
    return 'waiting'
  } catch {
    return 'waiting'
  } finally {
    await handle?.close()
  }
}

/**
 * Convenience wrapper that reads the transcript via the symlink at
 * .yaac-transcripts/{sessionId}.jsonl inside the codex dir.
 */
export async function getSessionCodexStatus(projectSlug: string, sessionId: string): Promise<'running' | 'waiting'> {
  return getCodexStatus(codexTranscriptFile(projectSlug, sessionId))
}

/**
 * Reads the beginning of a Codex JSONL session log and returns the text of
 * the first user message, or undefined if none is found.
 */
export async function getCodexFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => getUserMessageText(entry as CodexEntry))
}

/**
 * Convenience wrapper that reads the transcript via the symlink at
 * .yaac-transcripts/{sessionId}.jsonl inside the codex dir.
 */
export async function getSessionCodexFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  return getCodexFirstUserMessage(codexTranscriptFile(projectSlug, sessionId))
}
