import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/paths'

const WAITING_STOP_REASONS = new Set(['end_turn', 'refusal', 'stop_sequence'])

// Metadata entry types that Claude Code appends after a turn completes.
// These don't represent conversation state and must be skipped when
// determining whether Claude is running or waiting.
const METADATA_TYPES = new Set([
  'system',
  'last-prompt',
  'permission-mode',
  'file-history-snapshot',
  'agent-name',
  'custom-title',
  'queue-operation',
])

/**
 * Reads the tail of a JSONL session log and determines whether
 * Claude Code is actively working or waiting for user input.
 *
 * Claude Code appends metadata entries (turn_duration, last-prompt, etc.)
 * after an assistant turn completes, so we scan backwards past those to
 * find the last semantically meaningful entry (assistant, user, or attachment).
 */
export async function getClaudeStatus(jsonlPath: string): Promise<'running' | 'waiting'> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return 'waiting'

    // Read the last chunk of the file to find recent lines
    const chunkSize = Math.min(stat.size, 4096)
    const buf = Buffer.alloc(chunkSize)
    await handle.read(buf, 0, chunkSize, stat.size - chunkSize)
    const chunk = buf.toString('utf8')

    const lines = chunk.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return 'waiting'

    // Walk backwards, skipping metadata entries, to find the last
    // entry that reflects actual conversation state.
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as { type: string; message?: { stop_reason?: string } }

      if (METADATA_TYPES.has(entry.type)) continue

      if (entry.type !== 'assistant') return 'running'

      const stopReason = entry.message?.stop_reason
      return stopReason && WAITING_STOP_REASONS.has(stopReason) ? 'waiting' : 'running'
    }

    // All lines in the chunk were metadata — session just started
    return 'waiting'
  } catch {
    // File missing or parse error — assume waiting (session just booted, Claude hasn't started yet)
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
