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

/**
 * Short-TTL cache for `getSessionClaudeStatus` results, keyed by
 * container name. Same shape as `tmuxAliveCache` in cleanup.ts: each
 * entry holds either a settled (status, expiresAt) row or an in-flight
 * Promise so concurrent callers coalesce onto one `tmux capture-pane`
 * exec. Without this, `/session/list` (UI polls every ~5s, both with
 * and without a project filter), `getWaitingSessions` (called from the
 * stream-picker), and any overlap between them each fire an independent
 * capture-pane exec per claude container — and each capture-pane is a
 * 5-call exec lifecycle on the podman API. A 2s window matches the
 * tmux-alive cache TTL and keeps the displayed status well within the
 * UI's 5s poll cadence.
 */
const CLAUDE_STATUS_TTL_MS = 2_000

type ClaudeStatusEntry =
  | { kind: 'settled'; value: 'running' | 'waiting'; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<'running' | 'waiting'> }

const claudeStatusCache = new Map<string, ClaudeStatusEntry>()

/**
 * Test-only: drop every cached entry. Production callers never need to
 * invalidate because the TTL is short and `cleanupSession` already
 * removes the container — but tests that mock `podmanExecWithRetry`
 * across multiple cases need a clean slate per case.
 */
export function _clearClaudeStatusCacheForTests(): void {
  claudeStatusCache.clear()
}

/**
 * Drop the cached entry for one container. Called from cleanup.ts when
 * a session is torn down so a subsequent caller doesn't see a stale
 * status from the previous container with the same name.
 */
export function evictClaudeStatusCache(containerName: string): void {
  claudeStatusCache.delete(containerName)
}

async function probeClaudeStatus(containerName: string): Promise<'running' | 'waiting'> {
  const pane = await captureClaudePane(containerName)
  if (pane === undefined) return 'waiting'
  return classifyClaudePane(pane)
}

export async function getSessionClaudeStatus(
  _projectSlug: string,
  _sessionId: string,
  containerName: string,
): Promise<'running' | 'waiting'> {
  const now = Date.now()
  const cached = claudeStatusCache.get(containerName)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeClaudeStatus(containerName).then((value) => {
    claudeStatusCache.set(containerName, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + CLAUDE_STATUS_TTL_MS,
    })
    return value
  })
  claudeStatusCache.set(containerName, { kind: 'inflight', promise })
  return promise
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
