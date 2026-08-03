import { type SessionPod } from '#platform/k8s'
import { getSessionFirstUserMessage as getSessionClaudeFirstMessage } from '#features/sessions/agents/claude-status'
import { getSessionCodexFirstUserMessage } from '#features/sessions/agents/codex'
import { getSessionOpencodeFirstUserMessage } from '#features/sessions/agents/opencode'
import { getSessionPiFirstUserMessage } from '#features/sessions/agents/pi-status'
import type { AgentTool, SessionDeathCause } from '@yaac/shared/types'

// ---------------------------------------------------------------------------
// Tool + first-message lookup
// ---------------------------------------------------------------------------

/** Normalize a raw `yaac.tool` label value into an AgentTool. */
export function normalizeTool(raw: string | undefined): AgentTool {
  if (raw === 'codex') return 'codex'
  if (raw === 'opencode') return 'opencode'
  if (raw === 'pi') return 'pi'
  return 'claude'
}

/**
 * First-message lookup, used once per session by the capture step (and
 * on demand for a session that died before it ran). `jobName` is required
 * for opencode — it has no host transcript, so its first message can only
 * come from an HTTP probe into the running container — and ignored for
 * claude/codex/pi, which read JSONL files from host bind-mounts.
 */
export async function getSessionFirstMessage(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
  jobName?: string,
): Promise<string | undefined> {
  if (tool === 'codex') return getSessionCodexFirstUserMessage(projectSlug, sessionId)
  if (tool === 'pi') return getSessionPiFirstUserMessage(projectSlug, sessionId)
  if (tool === 'opencode') {
    return jobName ? getSessionOpencodeFirstUserMessage(jobName) : undefined
  }
  return getSessionClaudeFirstMessage(projectSlug, sessionId)
}

// ---------------------------------------------------------------------------
// Death-cause derivation
// ---------------------------------------------------------------------------

/**
 * Derive why a stopped session pod died from its captured terminal state
 * (`SessionPod.terminal`). This runs at reap time — the last moment the
 * evidence exists, since the reaper's own teardown deletes the Job and pod.
 * Only the pod-stopped family is derived here; reap classifications the
 * pod can't express (tmux gone, placeholder pane, orphan Job) are supplied
 * directly by the reap sites that detected them.
 */
export function deriveDeathCause(pod: SessionPod): SessionDeathCause {
  const t = pod.terminal
  if (t?.containerReason === 'OOMKilled') {
    return {
      reason: 'oom',
      ...(t.exitCode !== undefined ? { detail: `exit code ${t.exitCode}` } : {}),
    }
  }
  if (t?.podReason === 'Evicted') {
    return { reason: 'evicted', ...(t.podMessage ? { detail: t.podMessage } : {}) }
  }
  if (t?.exitCode !== undefined && t.exitCode !== 0) {
    // kubelet's generic terminated reason for a nonzero exit is 'Error' —
    // it adds nothing over the exit code; any other reason is kept.
    const parts = [`exit code ${t.exitCode}`]
    if (t.containerReason && t.containerReason !== 'Error') parts.push(t.containerReason)
    return { reason: 'crashed', detail: parts.join(', ') }
  }
  return { reason: 'pod-stopped' }
}

// ---------------------------------------------------------------------------
// Terminating registry
// ---------------------------------------------------------------------------

/**
 * Sessions whose teardown has been issued but whose pod may not yet carry a
 * Kubernetes deletionTimestamp — the gap between `cleanupSession*` starting
 * and the `kubectl delete` landing. Marking a session here lets the display
 * path render it as "terminating…" across that gap and for deletes that
 * originate outside the UI (CLI, the stale reaper), instead of the row
 * flashing a stray `waiting` spell on its way out.
 *
 * In-memory (server-process singleton): a restart drops the marks, which is
 * fine — a genuinely terminating pod still carries its own deletionTimestamp,
 * and `pruneTerminating` clears anything stale.
 */

/** sessionId -> epoch ms when the teardown was marked. */
const marks = new Map<string, number>()

/**
 * How long a mark survives without the pod actually disappearing. A *failed*
 * detached delete leaves the pod running and the id marked forever; after this
 * the row un-greys and the stale reaper takes over. Comfortably longer than a
 * normal teardown (pod grace 5s + kubectl delete).
 */
export const TERMINATING_TTL_MS = 60_000

/** Mark a session as terminating (idempotent; does not reset the timestamp so
 *  the TTL measures from the first mark). */
export function markSessionTerminating(sessionId: string, nowMs = Date.now()): void {
  if (!sessionId) return
  if (!marks.has(sessionId)) marks.set(sessionId, nowMs)
}

/** Whether a session is currently marked terminating. */
export function isSessionTerminating(sessionId: string): boolean {
  return marks.has(sessionId)
}

/** Drop a session's mark — called when its id is reused (restart) so a fresh
 *  incarnation isn't rendered as terminating. */
export function clearSessionTerminating(sessionId: string): void {
  marks.delete(sessionId)
}

/**
 * Forget marks that are no longer meaningful: the pod is gone (teardown
 * finished — the row leaves the list on its own) or the mark has outlived the
 * TTL (a failed teardown that never removed the pod). Called once per
 * display-list build.
 */
export function pruneTerminating(livePodIds: Set<string>, nowMs = Date.now()): void {
  for (const [sessionId, markedAt] of marks) {
    if (!livePodIds.has(sessionId) || nowMs - markedAt > TERMINATING_TTL_MS) {
      marks.delete(sessionId)
    }
  }
}

/** Test helper: drop all marks. */
export function _clearTerminatingForTests(): void {
  marks.clear()
}
