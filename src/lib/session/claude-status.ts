import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { claudeDir, sessionTmuxPaneLogPath } from '@/lib/project/paths'
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

/**
 * How many trailing bytes of `pane.log` to inspect on each probe. The
 * INTERRUPT_HINT match only needs to see the live render at the bottom
 * of the pane, so 8 KiB is generous. Larger reads cost more on every
 * 5s UI poll without buying any detection accuracy.
 */
const PANE_TAIL_BYTES = 8 * 1024

/**
 * Read the trailing `PANE_TAIL_BYTES` of the session's pipe-pane log,
 * then truncate the file in place. The in-container `cat >> pane.log`
 * writer runs in O_APPEND mode, so a truncate from the host just
 * resets the file size to 0 — the next pane update reappears at
 * offset 0. Returns `undefined` when the file doesn't exist yet
 * (container is still starting up).
 */
async function captureClaudePane(slug: string, sessionId: string): Promise<string | undefined> {
  const logPath = sessionTmuxPaneLogPath(slug, sessionId)
  let handle: FileHandle
  try {
    handle = await fs.open(logPath, 'r+')
  } catch {
    return undefined
  }
  try {
    const stat = await handle.stat()
    if (stat.size === 0) return ''
    const readSize = Math.min(stat.size, PANE_TAIL_BYTES)
    const offset = stat.size - readSize
    const buf = Buffer.alloc(readSize)
    await handle.read(buf, 0, readSize, offset)
    // Truncate AFTER the read so a concurrent appender that wrote
    // between read and truncate just gets folded into the next probe's
    // window (it would have been past the tail we just captured).
    await handle.truncate(0)
    return buf.toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => { /* best-effort */ })
  }
}

/**
 * Short-TTL cache for `getSessionClaudeStatus` results, keyed by
 * `${slug}/${sessionId}`. Same shape as `tmuxAliveCache` in cleanup.ts:
 * each entry holds either a settled (status, expiresAt) row or an
 * in-flight Promise so concurrent callers coalesce onto one file
 * read+truncate. Without this, `/session/list` (UI polls every ~5s,
 * both with and without a project filter), `getWaitingSessions`
 * (called from the stream-picker), and any overlap between them each
 * drive the same file read independently for every claude session.
 */
const CLAUDE_STATUS_TTL_MS = 2_000

type ClaudeStatusEntry =
  | { kind: 'settled'; value: 'running' | 'waiting'; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<'running' | 'waiting'> }

const claudeStatusCache = new Map<string, ClaudeStatusEntry>()

function claudeStatusKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

/**
 * Test-only: drop every cached entry. Production callers never need to
 * invalidate because the TTL is short and `cleanupSession` already
 * removes the pane log — but tests that drive the probe across
 * multiple cases need a clean slate per case.
 */
export function _clearClaudeStatusCacheForTests(): void {
  claudeStatusCache.clear()
}

/**
 * Drop the cached entry for one session. Called from cleanup.ts when a
 * session is torn down so a subsequent caller doesn't see a stale
 * status from a previous session.
 */
export function evictClaudeStatusCache(slug: string, sessionId: string): void {
  claudeStatusCache.delete(claudeStatusKey(slug, sessionId))
}

async function probeClaudeStatus(slug: string, sessionId: string): Promise<'running' | 'waiting'> {
  const pane = await captureClaudePane(slug, sessionId)
  if (pane === undefined) return 'waiting'
  return classifyClaudePane(pane)
}

export async function getSessionClaudeStatus(
  projectSlug: string,
  sessionId: string,
  _containerName: string,
): Promise<'running' | 'waiting'> {
  const key = claudeStatusKey(projectSlug, sessionId)
  const now = Date.now()
  const cached = claudeStatusCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeClaudeStatus(projectSlug, sessionId).then((value) => {
    claudeStatusCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + CLAUDE_STATUS_TTL_MS,
    })
    return value
  })
  claudeStatusCache.set(key, { kind: 'inflight', promise })
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
