import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/project/paths'
import { scanJsonlForward } from '@/lib/session/jsonl'

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
  toolUseResult?: {
    type?: string
    filePath?: string
    structuredPatch?: unknown
  }
}

// Deferred tools whose schema must be fetched via ToolSearch before they can
// be invoked. When the schema fetch returns, the UI blocks before the actual
// call lands in the JSONL, so a tool_reference for any of these names is the
// last conversation entry while the session waits for user input.
const BLOCKING_DEFERRED_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion'])

/**
 * Checks whether an entry is a ToolSearch result whose tool_reference points
 * at a blocking deferred tool (e.g. ExitPlanMode for plan approval, or
 * AskUserQuestion for an inline question). The UI blocks between the schema
 * fetch returning and the actual tool call, so this entry shape signals that
 * the session is waiting on user input.
 */
function isBlockingDeferredToolFetch(entry: ConversationEntry): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const sub of block.content) {
        if (sub.type === 'tool_reference' && BLOCKING_DEFERRED_TOOLS.has(sub.tool_name ?? '')) {
          return true
        }
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
const PLAN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/**
 * Checks whether an assistant entry is a Write/Edit/MultiEdit to a plan file.
 * When Claude writes or updates a plan, the plan-approval UI blocks before the
 * next API request, so the assistant tool_use is the last entry in the JSONL.
 */
function isPlanFileWrite(entry: ConversationEntry): boolean {
  if (entry.type !== 'assistant') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (
      block.type === 'tool_use' &&
      PLAN_WRITE_TOOLS.has(block.name ?? '') &&
      PLAN_FILE_RE.test(block.input?.file_path ?? '')
    ) {
      return true
    }
  }
  return false
}

/**
 * Checks whether a user entry is the tool_result for a Write/Edit/MultiEdit
 * to a plan file. After Claude writes or updates a plan, the plan-approval UI
 * blocks before the next API request. If the result is the last conversation
 * entry (e.g. no subsequent ExitPlanMode call), the session is waiting for
 * approval.
 *
 * Write results have `type: 'create' | 'update'`. Edit/MultiEdit results omit
 * the type field but include a `structuredPatch`. Either shape, targeting a
 * plan-file path, counts as a plan-file write.
 */
const FILE_WRITE_TYPES = new Set(['create', 'update'])

function isPlanFileWriteResult(entry: ConversationEntry): boolean {
  if (entry.type !== 'user') return false
  const result = entry.toolUseResult
  if (!result) return false
  if (!PLAN_FILE_RE.test(result.filePath ?? '')) return false
  if (FILE_WRITE_TYPES.has(result.type ?? '')) return true
  if (result.structuredPatch !== undefined) return true
  return false
}

/**
 * Checks whether an assistant entry is calling ExitPlanMode. The plan-approval
 * UI blocks before executing this tool, so the session is waiting for user
 * input, not running.
 */
function isExitPlanModeCall(entry: ConversationEntry): boolean {
  if (entry.type !== 'assistant') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'ExitPlanMode') return true
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

        if (isBlockingDeferredToolFetch(entry)) return 'waiting'
        if (isPlanFileWrite(entry)) return 'waiting'
        if (isPlanFileWriteResult(entry)) return 'waiting'
        if (isExitPlanModeCall(entry)) return 'waiting'
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
          if (isBlockingDeferredToolFetch(entry)) return 'waiting'
          if (isPlanFileWrite(entry)) return 'waiting'
          if (isPlanFileWriteResult(entry)) return 'waiting'
          if (isExitPlanModeCall(entry)) return 'waiting'
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
  return scanJsonlForward(jsonlPath, (entry) => {
    const parsed = entry as {
      type: string
      message?: { role?: string; content?: string | Array<{ type: string; text?: string }> }
    }
    if (parsed.type !== 'user') return undefined

    const content = parsed.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const textBlock = content.find((b) => b.type === 'text')
      if (textBlock?.text) return textBlock.text
    }
    return undefined
  })
}

/**
 * Convenience wrapper that constructs the JSONL path from project slug and session ID.
 */
export async function getSessionFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  const jsonlPath = path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
  return getFirstUserMessage(jsonlPath)
}
