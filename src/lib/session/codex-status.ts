import fs from 'node:fs/promises'
import { codexTranscriptFile } from '@/lib/project/paths'

interface CodexEntry {
  type: string
  message?: string
  item?: {
    type?: string
    status?: string
  }
}

const CHUNK_SIZE = 4096

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

        // turn.completed means Codex finished processing — waiting for input
        if (entry.type === 'turn.completed') return 'waiting'
        // turn.failed also means Codex stopped
        if (entry.type === 'turn.failed') return 'waiting'
        // turn.started or item events mean Codex is actively working
        if (entry.type === 'turn.started') return 'running'
        if (entry.type === 'item.started') return 'running'
        if (entry.type === 'item.updated') return 'running'
        // event_msg is user input — Codex should be processing after this
        if (entry.type === 'event_msg') return 'running'
      }
    }

    // Process the final carryover
    if (carryover.trim().length > 0) {
      try {
        const entry = JSON.parse(carryover) as CodexEntry
        if (entry.type === 'turn.completed' || entry.type === 'turn.failed') return 'waiting'
        if (entry.type === 'turn.started' || entry.type === 'item.started' || entry.type === 'event_msg') return 'running'
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
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return undefined

    const chunkSize = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(chunkSize)
    await handle.read(buf, 0, chunkSize, 0)
    const chunk = buf.toString('utf8')

    const lines = chunk.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      let entry: { type: string; message?: string }
      try {
        entry = JSON.parse(line) as { type: string; message?: string }
      } catch {
        continue
      }
      // event_msg entries contain user messages
      if (entry.type === 'event_msg' && entry.message) {
        return entry.message
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * Convenience wrapper that reads the transcript via the symlink at
 * .yaac-transcripts/{sessionId}.jsonl inside the codex dir.
 */
export async function getSessionCodexFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  return getCodexFirstUserMessage(codexTranscriptFile(projectSlug, sessionId))
}
