import path from 'node:path'
import { podmanExecWithRetry } from '@/lib/container/runtime'
import { claudeDir } from '@/lib/project/paths'
import { scanJsonlForward } from '@/lib/session/jsonl'

/**
 * Detects Claude Code's "actively working" state from tmux pane content.
 * Claude Code renders an interrupt hint — "ctrl+c to interrupt" or
 * "esc to interrupt" — only while a turn is in flight (API call, tool
 * running, streaming response). Once the turn yields control back to the
 * user (idle prompt, permission [y/n], ExitPlanMode approval, or
 * AskUserQuestion selector), the hint disappears.
 *
 * This matters because the JSONL transcript is not a reliable status
 * source for AskUserQuestion / permission / plan-approval waits: Claude
 * Code does not persist the blocking assistant tool_use until the user
 * answers, so the JSONL tail sits at a user tool_result with no
 * indication that the next turn has stalled on a UI. Inspecting the
 * pane sidesteps that entirely.
 */
const INTERRUPT_HINT = /(?:ctrl\+c|esc)\s+to\s+interrupt/i

export function classifyClaudePane(paneContent: string): 'running' | 'waiting' {
  return INTERRUPT_HINT.test(paneContent) ? 'running' : 'waiting'
}

const CAPTURE_TIMEOUT_MS = 3000

async function captureClaudePane(containerName: string): Promise<string | undefined> {
  try {
    const { stdout } = await podmanExecWithRetry(
      ['exec', containerName, 'tmux', 'capture-pane', '-p', '-t', 'yaac:claude.0'],
      { maxAttempts: 2, baseDelay: 100, timeout: CAPTURE_TIMEOUT_MS },
    )
    return stdout
  } catch {
    return undefined
  }
}

export async function getSessionClaudeStatus(
  _projectSlug: string,
  _sessionId: string,
  containerName: string,
): Promise<'running' | 'waiting'> {
  const pane = await captureClaudePane(containerName)
  if (pane === undefined) return 'waiting'
  return classifyClaudePane(pane)
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
