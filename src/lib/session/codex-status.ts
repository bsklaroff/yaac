import { codexTranscriptFile } from '@/lib/project/paths'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import { containerExec } from '@/lib/k8s/exec'
import { scanJsonlForward } from '@/lib/session/jsonl'

interface CodexEntry {
  type: string
  payload?: {
    type?: string
    message?: string
  }
}

function getUserMessageText(entry: CodexEntry): string | undefined {
  if (entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string' && entry.payload.message.length > 0) {
    return entry.payload.message
  }
  return undefined
}

/**
 * Detects Codex's "actively working" state from the pane's OSC terminal
 * title, mirroring claude-status.ts. Codex's default terminal title is
 * built from the `[tui].terminal_title` items `["activity",
 * "project-name"]`: while a task is running the activity item renders a
 * Braille spinner frame (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, all inside U+2800–U+28FF) ahead of
 * the project name, and the moment the turn ends the title drops back to
 * the bare project name. When Codex blocks on user input (an approval
 * prompt) the spinner is suppressed entirely and the title instead gains
 * a blinking "[ ! ] Action Required" prefix — so the leading-Braille test
 * classifies every user-blocked state as 'waiting', which is exactly what
 * the JSONL transcript could not reliably tell us (verified against
 * codex-cli 0.142.4: codex-rs/tui/src/chatwidget/status_surfaces.rs, and
 * live — a turn in flight cycles all ten spinner frames in the title).
 *
 * Before Codex sets a title the pane reports tmux's default (the pod
 * hostname), which classifies as 'waiting' — the right answer for a
 * session still booting.
 */
const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28FF]/

export function classifyCodexTitle(title: string): 'running' | 'waiting' {
  return BRAILLE_SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Read the codex agent pane's OSC title by shelling into the session
 * pod and asking tmux for `#{pane_title}`. Returns `undefined` if the
 * pod or tmux session isn't ready yet (e.g. mid-startup).
 */
async function readCodexPaneTitle(jobName: string): Promise<string | undefined> {
  try {
    const { stdout } = await containerExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} display-message -p -t yaac:codex.0 '#{pane_title}'`,
      { maxAttempts: 1 },
    )
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Short-TTL cache for `getSessionCodexStatus` results, keyed by
 * `${slug}/${sessionId}`. Same shape as the claude-status cache: each
 * entry holds either a settled (status, expiresAt) row or an in-flight
 * Promise so concurrent callers coalesce onto one title probe. Without
 * this, `/session/list` (UI polls every ~5s, both with and without a
 * project filter), `getWaitingSessions` (called from the stream-picker),
 * and any overlap between them each drive their own `kubectl exec`
 * independently for every codex session.
 */
const CODEX_STATUS_TTL_MS = 2_000

type CodexStatusEntry =
  | { kind: 'settled'; value: 'running' | 'waiting'; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<'running' | 'waiting'> }

const codexStatusCache = new Map<string, CodexStatusEntry>()

function codexStatusKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

/**
 * Test-only: drop every cached entry. Production callers never need to
 * invalidate because the TTL is short and `cleanupSession` already
 * evicts the entry on teardown — but tests that drive the probe across
 * multiple cases need a clean slate per case.
 */
export function _clearCodexStatusCacheForTests(): void {
  codexStatusCache.clear()
}

/**
 * Drop the cached entry for one session. Called from cleanup.ts when a
 * session is torn down so a subsequent caller doesn't see a stale
 * status from a previous session.
 */
export function evictCodexStatusCache(slug: string, sessionId: string): void {
  codexStatusCache.delete(codexStatusKey(slug, sessionId))
}

async function probeCodexStatus(jobName: string): Promise<'running' | 'waiting'> {
  const title = await readCodexPaneTitle(jobName)
  if (title === undefined) return 'waiting'
  return classifyCodexTitle(title)
}

export async function getSessionCodexStatus(
  projectSlug: string,
  sessionId: string,
  jobName: string,
): Promise<'running' | 'waiting'> {
  const key = codexStatusKey(projectSlug, sessionId)
  const now = Date.now()
  const cached = codexStatusCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeCodexStatus(jobName).then((value) => {
    codexStatusCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + CODEX_STATUS_TTL_MS,
    })
    return value
  })
  codexStatusCache.set(key, { kind: 'inflight', promise })
  return promise
}

/**
 * Reads the beginning of a Codex JSONL session log and returns the text of
 * the first user message, or undefined if none is found.
 */
export async function getCodexFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => getUserMessageText(entry as CodexEntry))
}

/**
 * Convenience wrapper that reads the transcript via the symlink at
 * .yaac-transcripts/{sessionId}.jsonl inside the codex dir.
 */
export async function getSessionCodexFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  return getCodexFirstUserMessage(codexTranscriptFile(projectSlug, sessionId))
}
