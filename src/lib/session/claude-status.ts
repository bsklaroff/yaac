import path from 'node:path'
import { claudeDir } from '@/lib/project/paths'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import { shellPodmanWithRetry } from '@/lib/container/runtime'
import { scanJsonlForward } from '@/lib/session/jsonl'

/**
 * Detects Claude Code's "actively working" state from the rendered tmux
 * pane. Claude Code renders an interrupt hint — "ctrl+c to interrupt" or
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
 *
 * We can't read pipe-pane output directly: Claude Code's TUI paints the
 * screen by absolute cursor positioning one character at a time, so the
 * raw byte stream contains no contiguous text to grep. Instead we ask
 * tmux for its rendered grid via `capture-pane -p`, which gives back
 * plain visible text.
 *
 * We only scan the bottom of the pane because the pane is 200 lines tall
 * (see -y in session-create.ts) and transcript history scrolls up but
 * stays visible. Assistant content can legitimately contain the literal
 * string "esc to interrupt" — a Web Search query, a discussion of this
 * very regex, etc. — and would otherwise false-positive as "running".
 * The live spinner/status-bar footer always sits at the very bottom of
 * the pane regardless of how much transcript precedes it.
 */
const INTERRUPT_HINT = /(?:ctrl\+c|esc)\s+to\s+interrupt/i
// The live hint lives in the bottom status bar / spinner line. While
// Claude Code is running subagents it renders a task list at the very
// bottom of the pane, which pushes the hint up several rows — a 3-row
// window missed it and misreported the session as 'waiting'. 10 rows
// covers the hint plus a typical task list while still staying well
// clear of transcript history (the pane is 200 rows tall), so assistant
// text that happens to quote "esc to interrupt" doesn't false-positive.
const FOOTER_LINES = 10

// Claude Code truncates its bottom status bar to the pane width with a
// trailing ellipsis, so on narrow panes (the window tracks the attached
// client) the hint can render as "… · esc t…". Catch any candidate that
// starts like the hint and ends in "…"; `isTruncatedInterruptHint`
// verifies the cut-off text is a genuine prefix of the full phrase, so
// idle hints like "esc to undo" can never slip through.
const TRUNCATED_HINT_CANDIDATE = /(?:ctrl\+c|esc)[^\n·…]{0,20}…/gi
const FULL_HINTS = ['ctrl+c to interrupt', 'esc to interrupt']

function isTruncatedInterruptHint(candidate: string): boolean {
  const cut = candidate.replace(/…$/, '').replace(/\s+/g, ' ').trimEnd().toLowerCase()
  return FULL_HINTS.some((full) => full.startsWith(cut))
}

export function classifyClaudePane(paneContent: string): 'running' | 'waiting' {
  const lines = paneContent.split('\n')
  const footer = lines.slice(-FOOTER_LINES).join('\n')
  if (INTERRUPT_HINT.test(footer)) return 'running'
  for (const m of footer.match(TRUNCATED_HINT_CANDIDATE) ?? []) {
    if (isTruncatedInterruptHint(m)) return 'running'
  }
  return 'waiting'
}

/**
 * Capture the visible portion of the claude agent pane as plain text by
 * shelling into the container and running `tmux capture-pane -p`. The
 * `-J` flag joins wrapped lines so wide-terminal wrapping never splits
 * the interrupt hint across two lines. Returns `undefined` if the
 * container or tmux session isn't ready yet (e.g. mid-startup).
 */
async function captureClaudePane(containerName: string): Promise<string | undefined> {
  try {
    const { stdout } = await shellPodmanWithRetry(
      `podman exec ${containerName} tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -pJ -t yaac:claude.0`,
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
 * capture-pane call. Without this, `/session/list` (UI polls every ~5s,
 * both with and without a project filter), `getWaitingSessions`
 * (called from the stream-picker), and any overlap between them each
 * drive their own `podman exec` independently for every claude session.
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

async function probeClaudeStatus(containerName: string): Promise<'running' | 'waiting'> {
  const pane = await captureClaudePane(containerName)
  if (pane === undefined) return 'waiting'
  return classifyClaudePane(pane)
}

export async function getSessionClaudeStatus(
  projectSlug: string,
  sessionId: string,
  containerName: string,
): Promise<'running' | 'waiting'> {
  const key = claudeStatusKey(projectSlug, sessionId)
  const now = Date.now()
  const cached = claudeStatusCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeClaudeStatus(containerName).then((value) => {
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
