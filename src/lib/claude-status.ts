import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/paths'

const WAITING_STOP_REASONS = new Set(['end_turn', 'refusal', 'stop_sequence'])

/**
 * Reads the last line of a JSONL session log and determines whether
 * Claude Code is actively working or waiting for user input.
 */
export async function getClaudeStatus(jsonlPath: string): Promise<'running' | 'waiting'> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return 'waiting'

    // Read the last chunk of the file to find the final line
    const chunkSize = Math.min(stat.size, 4096)
    const buf = Buffer.alloc(chunkSize)
    await handle.read(buf, 0, chunkSize, stat.size - chunkSize)
    const chunk = buf.toString('utf8')

    // Find the last non-empty line
    const lines = chunk.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return 'waiting'

    const lastLine = lines[lines.length - 1]
    const entry = JSON.parse(lastLine)

    if (entry.type !== 'assistant') return 'running'

    const stopReason = entry.message?.stop_reason ?? null
    return WAITING_STOP_REASONS.has(stopReason) ? 'waiting' : 'running'
  } catch {
    // File missing or parse error — assume running (safer default)
    return 'running'
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
