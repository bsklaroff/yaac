import path from 'node:path'
import { claudeDir } from '@/lib/project/paths'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import { containerExec } from '@/lib/k8s/exec'
import { scanJsonlForward } from '@/lib/session/jsonl'

/**
 * Detects Claude Code's "actively working" state from the pane's OSC
 * terminal title. Claude Code mirrors its spinner into the title: while
 * a turn is in flight (API call, tool running, streaming response) the
 * title reads "<spinner> <task summary>" with the leading glyph cycling
 * through the Braille block (U+2800–U+28FF, the ⠋⠙⠹… animation). The
 * moment control returns to the user — idle prompt, permission dialog,
 * ExitPlanMode approval, or AskUserQuestion selector — the prefix flips
 * to "✳" (U+2733). Each of those states was verified against a live
 * session, permission dialog included; that one matters because the
 * JSONL transcript can't see UI-blocked turns (Claude Code does not
 * persist the blocking assistant tool_use until the user answers).
 *
 * tmux exposes the OSC title as `#{pane_title}` (`allow-set-title` is
 * on by default), so unlike scraping the rendered grid with
 * capture-pane there is nothing to parse: no footer-window heuristics,
 * no status-bar width truncation, and transcript text that merely
 * quotes a spinner glyph can't false-positive because only the title's
 * first character counts.
 *
 * Before Claude Code sets a title the pane reports tmux's default (the
 * pod hostname), which classifies as 'waiting' — the right answer for
 * a session still booting.
 */
const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28FF]/

export function classifyClaudeTitle(title: string): 'running' | 'waiting' {
  return BRAILLE_SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Read the claude agent pane's OSC title by shelling into the session
 * pod and asking tmux for `#{pane_title}`. Returns `undefined` if the
 * pod or tmux session isn't ready yet (e.g. mid-startup).
 */
async function readClaudePaneTitle(jobName: string): Promise<string | undefined> {
  try {
    const { stdout } = await containerExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} display-message -p -t yaac:claude.0 '#{pane_title}'`,
      { maxAttempts: 1 },
    )
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Short-TTL cache for `getSessionClaudeStatus` results, keyed by
 * `${slug}/${sessionId}`. Same shape as `tmuxAliveCache` in cleanup.ts:
 * each entry holds either a settled (status, expiresAt) row or an
 * in-flight Promise so concurrent callers coalesce onto one
 * title probe. Without this, `/session/list` (UI polls every ~5s,
 * both with and without a project filter), `getWaitingSessions`
 * (called from the stream-picker), and any overlap between them each
 * drive their own `kubectl exec` independently for every claude session.
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
 * evicts the entry on teardown — but tests that drive the probe across
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

async function probeClaudeStatus(jobName: string): Promise<'running' | 'waiting'> {
  const title = await readClaudePaneTitle(jobName)
  if (title === undefined) return 'waiting'
  return classifyClaudeTitle(title)
}

export async function getSessionClaudeStatus(
  projectSlug: string,
  sessionId: string,
  jobName: string,
): Promise<'running' | 'waiting'> {
  const key = claudeStatusKey(projectSlug, sessionId)
  const now = Date.now()
  const cached = claudeStatusCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeClaudeStatus(jobName).then((value) => {
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
