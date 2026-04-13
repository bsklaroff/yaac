import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/paths'

const WAITING_STOP_REASONS = new Set(['end_turn', 'refusal', 'stop_sequence'])

// Only these entry types represent actual conversation state.
// Everything else (system, last-prompt, permission-mode, file-history-snapshot,
// agent-name, custom-title, queue-operation, and any future metadata types) is
// skipped when determining whether Claude is running or waiting.
const CONVERSATION_TYPES = new Set(['assistant', 'user'])

const CHUNK_SIZE = 4096

/**
 * Reads lines from the end of a JSONL session log, scanning backwards
 * until it finds a conversation entry (assistant or user) that reveals
 * whether Claude Code is actively working or waiting for user input.
 *
 * Reads in 4KB chunks from the end, expanding as needed so that an
 * arbitrary amount of trailing metadata never causes a false "waiting".
 */
export async function getClaudeStatus(jsonlPath: string): Promise<'running' | 'waiting'> {
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

      // Prepend to any leftover partial line from the previous iteration
      const raw = buf.toString('utf8') + carryover
      const parts = raw.split('\n')

      // The first element may be a partial line (we landed mid-line).
      // Save it as carryover for the next chunk read.
      carryover = parts[0]

      // Scan the remaining lines (complete) from bottom to top
      for (let i = parts.length - 1; i >= 1; i--) {
        const line = parts[i].trim()
        if (line.length === 0) continue

        let entry: { type: string; message?: { stop_reason?: string } }
        try {
          entry = JSON.parse(line) as typeof entry
        } catch {
          continue // skip unparseable lines
        }

        if (!CONVERSATION_TYPES.has(entry.type)) continue

        if (entry.type !== 'assistant') return 'running'

        const stopReason = entry.message?.stop_reason
        return stopReason && WAITING_STOP_REASONS.has(stopReason) ? 'waiting' : 'running'
      }
    }

    // Process the final carryover (the very first line in the file)
    if (carryover.trim().length > 0) {
      try {
        const entry = JSON.parse(carryover) as { type: string; message?: { stop_reason?: string } }
        if (CONVERSATION_TYPES.has(entry.type)) {
          if (entry.type !== 'assistant') return 'running'
          const stopReason = entry.message?.stop_reason
          return stopReason && WAITING_STOP_REASONS.has(stopReason) ? 'waiting' : 'running'
        }
      } catch {
        // ignore parse error on first line
      }
    }

    // Entire file was metadata — session just started
    return 'waiting'
  } catch {
    // File missing or unreadable — assume waiting (session just booted)
    return 'waiting'
  } finally {
    await handle?.close()
  }
}

/**
 * Convenience wrapper that constructs the JSONL path from project slug and session ID.
 */
export async function getSessionClaudeStatus(projectSlug: string, sessionId: string): Promise<'running' | 'waiting'> {
  const jsonlPath = path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
  return getClaudeStatus(jsonlPath)
}

/**
 * Reads the beginning of a JSONL session log and returns the text content
 * of the first user message, or undefined if none is found.
 */
export async function getFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return undefined

    // Read the first chunk — user message is typically near the top
    const chunkSize = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(chunkSize)
    await handle.read(buf, 0, chunkSize, 0)
    const chunk = buf.toString('utf8')

    const lines = chunk.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        type: string
        message?: { role?: string; content?: string | Array<{ type: string; text?: string }> }
      }
      if (entry.type !== 'user') continue

      const content = entry.message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const textBlock = content.find((b) => b.type === 'text')
        if (textBlock?.text) return textBlock.text
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
 * Convenience wrapper that constructs the JSONL path from project slug and session ID.
 */
export async function getSessionFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  const jsonlPath = path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
  return getFirstUserMessage(jsonlPath)
}
