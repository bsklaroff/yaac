import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/paths'

const WAITING_STOP_REASONS = new Set(['end_turn', 'refusal', 'stop_sequence'])

// Only these entry types represent actual conversation state.
// Everything else (system, last-prompt, permission-mode, file-history-snapshot,
// agent-name, custom-title, queue-operation, and any future metadata types) is
// skipped when determining whether Claude is running or waiting.
const CONVERSATION_TYPES = new Set(['assistant', 'user'])

interface ContentBlock {
  type: string
  name?: string
  tool_name?: string
  text?: string
  content?: string | ContentBlock[]
  input?: { file_path?: string }
}

interface ConversationEntry {
  type: string
  message?: {
    stop_reason?: string
    content?: ContentBlock[]
  }
}

/**
 * Checks whether an entry indicates Claude is waiting for user feedback on a
 * plan. When Claude finishes writing a plan, it fetches the ExitPlanMode tool
 * schema via ToolSearch. The plan-approval UI then blocks before the actual
 * ExitPlanMode call is made, so the ToolSearch result (a user tool_result
 * containing an ExitPlanMode tool_reference) is the last entry in the JSONL.
 */
function isWaitingForPlanApproval(entry: ConversationEntry): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const sub of block.content) {
        if (sub.type === 'tool_reference' && sub.tool_name === 'ExitPlanMode') return true
      }
    }
  }
  return false
}

const INTERRUPT_TEXT = '[Request interrupted by user for tool use]'

/**
 * Checks whether an entry is a user interrupt. When the user cancels a
 * running request, Claude Code appends a user message with the interrupt
 * text. Claude is no longer processing at that point, so the session is
 * waiting for new input.
 */
function isUserInterrupt(entry: ConversationEntry): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'text' && block.text === INTERRUPT_TEXT) return true
  }
  return false
}

/**
 * Checks whether an assistant entry is an AskUserQuestion tool call.
 * When Claude invokes AskUserQuestion the session blocks until the user
 * responds, so the status should be "waiting", not "running".
 */
function isAskingUserQuestion(entry: ConversationEntry): boolean {
  if (entry.type !== 'assistant') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'AskUserQuestion') return true
  }
  return false
}

const PLAN_FILE_RE = /\/\.claude\/plans\//

/**
 * Checks whether an assistant entry is a Write to a plan file. When Claude
 * writes or updates a plan, the plan-approval UI blocks before the next API
 * request, so the assistant tool_use Write is the last entry in the JSONL.
 */
function isPlanFileWrite(entry: ConversationEntry): boolean {
  if (entry.type !== 'assistant') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'Write' && PLAN_FILE_RE.test(block.input?.file_path ?? '')) {
      return true
    }
  }
  return false
}

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

        let entry: ConversationEntry
        try {
          entry = JSON.parse(line) as ConversationEntry
        } catch {
          continue // skip unparseable lines
        }

        if (!CONVERSATION_TYPES.has(entry.type)) continue

        if (isWaitingForPlanApproval(entry)) return 'waiting'
        if (isPlanFileWrite(entry)) return 'waiting'
        if (isUserInterrupt(entry)) return 'waiting'
        if (isAskingUserQuestion(entry)) return 'waiting'

        if (entry.type !== 'assistant') return 'running'

        const stopReason = entry.message?.stop_reason
        return stopReason && WAITING_STOP_REASONS.has(stopReason) ? 'waiting' : 'running'
      }
    }

    // Process the final carryover (the very first line in the file)
    if (carryover.trim().length > 0) {
      try {
        const entry = JSON.parse(carryover) as ConversationEntry
        if (CONVERSATION_TYPES.has(entry.type)) {
          if (isWaitingForPlanApproval(entry)) return 'waiting'
          if (isPlanFileWrite(entry)) return 'waiting'
          if (isUserInterrupt(entry)) return 'waiting'
          if (isAskingUserQuestion(entry)) return 'waiting'
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
