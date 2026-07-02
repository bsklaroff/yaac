import fs from 'node:fs/promises'
import { containerExec } from '@/lib/k8s/exec'
import { opencodeMetaFile } from '@/lib/project/paths'
import type { OpencodeSessionMeta } from '@/shared/types'

/**
 * Status classification + first-message lookup for opencode sessions.
 *
 * Status is read from the rendered tmux pane (window `yaac:opencode.0`),
 * not opencode's `/session/status` HTTP endpoint. The HTTP `type` field
 * (`idle` | `busy` | `retry`) stays at `busy` while opencode is paused on
 * a tool-permission prompt or a question-tool prompt — both states where
 * yaac should report `waiting`. Pane content carries unambiguous markers
 * for each. The pane is captured by the session's status watcher
 * (`src/daemon/status-watcher.ts`) over its persistent control-mode
 * stream — `%output` events are the dirty bit — and classified with
 * `classifyOpencodePane`; reads happen via the status store.
 *
 * First-message lookup still goes through the HTTP server: opencode
 * auto-populates `session.title` from the first user prompt, which is
 * what the TUI's own switcher displays — using it here keeps the two
 * views consistent.
 */

const OPENCODE_PROBE_TTL_MS = 2_000
const PROBE_TIMEOUT_MS = 3000

interface OpencodeProbe {
  sessions: OpencodeSessionRow[]
}

interface OpencodeSessionRow {
  id: string
  title?: string
  directory?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

type ProbeEntry =
  | { kind: 'settled'; value: OpencodeProbe | null; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<OpencodeProbe | null> }

function probeCacheKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

const probeCache = new Map<string, ProbeEntry>()

/**
 * Test-only: drop every cached entry between cases.
 */
export function _clearOpencodeProbeCacheForTests(): void {
  probeCache.clear()
}

/**
 * Drop the cached entry for one session. Called from cleanup.ts when
 * a session is torn down so a subsequent caller doesn't see a stale
 * probe from a brand-new session that reuses the same id (e.g. on
 * restart). Keyed by (slug, sessionId) — matches the tmux-alive
 * eviction signature.
 */
export function evictOpencodeProbeCache(slug: string, sessionId: string): void {
  probeCache.delete(probeCacheKey(slug, sessionId))
}

/**
 * Classify a captured opencode tmux pane into `running` / `waiting`.
 *
 * While a turn is in flight the footer status line renders an animated
 * strip of ■/⬝ cells followed by the interrupt hint ("esc interrupt",
 * or "esc again to interrupt" after one ESC) — either marker means
 * `running`. Everything else is `waiting`: the status line only exists
 * when no footer panel is open (`footer.view.tsx` renders it under
 * `!panel() && !menu()`), and permission / question dialogs are panels,
 * so a dialog *replaces* the busy markers rather than overlaying them.
 * That's why the old dialog special-cases are gone — a user-blocked
 * pane simply carries neither signal (verified against opencode
 * 1.17.11: a busy footer reads e.g. "■■■■■⬝⬝⬝  esc interrupt").
 */
const INTERRUPT_HINT = /esc\s+(?:again\s+to\s+)?interrupt/i
const BUSY_STRIP = /(?:■|⬝){4,}/

export function classifyOpencodePane(paneContent: string): 'running' | 'waiting' {
  if (INTERRUPT_HINT.test(paneContent)) return 'running'
  if (BUSY_STRIP.test(paneContent)) return 'running'
  return 'waiting'
}

async function runProbe(jobName: string): Promise<OpencodeProbe | null> {
  // One kubectl exec → curl /session. -sf suppresses output on curl
  // failure (HTTP server not up yet, etc.); we then see empty/non-JSON
  // below and return null.
  let stdout: string
  try {
    const result = await containerExec(
      jobName,
      'curl -sf http://127.0.0.1:4096/session',
      { maxAttempts: 2, baseDelay: 100, timeout: PROBE_TIMEOUT_MS },
    )
    stdout = result.stdout
  } catch {
    return null
  }

  if (!stdout) return null
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (!Array.isArray(parsed)) return null
    return { sessions: parsed as OpencodeSessionRow[] }
  } catch {
    return null
  }
}

/**
 * Coalesce concurrent /session probes against the same session into one
 * exec and cache the result for OPENCODE_PROBE_TTL_MS. Keyed by
 * (slug, sessionId) so a restart that reuses the same Job name
 * doesn't accidentally read a previous-session probe.
 */
async function probeOpencode(
  slug: string,
  sessionId: string,
  jobName: string,
): Promise<OpencodeProbe | null> {
  const key = probeCacheKey(slug, sessionId)
  const now = Date.now()
  const cached = probeCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = runProbe(jobName).then((value) => {
    probeCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + OPENCODE_PROBE_TTL_MS,
    })
    return value
  })
  probeCache.set(key, { kind: 'inflight', promise })
  return promise
}

/**
 * Pick "this container's" session from the probe. With per-yaac-session
 * data dir isolation there should only ever be one (plus optional forks
 * with non-null parentID), but we still pick the most-recently-updated
 * root session defensively.
 */
export function pickOpencodeSession(probe: OpencodeProbe): OpencodeSessionRow | undefined {
  const roots = probe.sessions.filter((s) => !s.parentID)
  const candidates = roots.length > 0 ? roots : probe.sessions
  return [...candidates].sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  )[0]
}

async function loadOpencodeMeta(
  projectSlug: string,
  sessionId: string,
): Promise<OpencodeSessionMeta | null> {
  try {
    const raw = await fs.readFile(opencodeMetaFile(projectSlug, sessionId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    const result: OpencodeSessionMeta = {}
    if (typeof o.firstMessage === 'string') result.firstMessage = o.firstMessage
    if (typeof o.capturedAt === 'string') result.capturedAt = o.capturedAt
    return result
  } catch {
    return null
  }
}

async function saveOpencodeMeta(
  projectSlug: string,
  sessionId: string,
  meta: OpencodeSessionMeta,
): Promise<void> {
  try {
    await fs.writeFile(
      opencodeMetaFile(projectSlug, sessionId),
      JSON.stringify(meta, null, 2) + '\n',
    )
  } catch {
    // Non-fatal: meta-file caching is for deleted-session lookups; if
    // we can't write, getSessionOpencodeFirstUserMessage just falls
    // back to re-probing next time.
  }
}

/**
 * First user message for an opencode session, used by `yaac session
 * list` to show a prompt preview. opencode auto-generates
 * `session.title` from the first prompt, which is what the TUI's own
 * session switcher displays — using it here keeps the two views in
 * sync.
 *
 * Successful captures are persisted to opencodeMetaFile so subsequent
 * lookups (including for deleted sessions whose container is gone)
 * return the cached value without needing to re-probe.
 */
export async function getSessionOpencodeFirstUserMessage(
  projectSlug: string,
  sessionId: string,
  jobName: string,
): Promise<string | undefined> {
  // Probe the live container first to pick up any title updates that
  // happened since we last cached.
  const probe = await probeOpencode(projectSlug, sessionId, jobName)
  const session = probe ? pickOpencodeSession(probe) : undefined
  if (session?.title) {
    await saveOpencodeMeta(projectSlug, sessionId, {
      firstMessage: session.title,
      capturedAt: new Date().toISOString(),
    })
    return session.title
  }
  // Pod gone or no session yet — fall back to the cached snapshot.
  const meta = await loadOpencodeMeta(projectSlug, sessionId)
  return meta?.firstMessage
}

/**
 * Deleted-session first-message lookup: the Job is gone, so probe
 * isn't an option. Reads straight from the cached meta file.
 */
export async function getDeletedSessionOpencodeFirstUserMessage(
  projectSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  const meta = await loadOpencodeMeta(projectSlug, sessionId)
  return meta?.firstMessage
}

/**
 * Capture-and-persist the first-message snapshot for a live opencode
 * session, but only if one isn't already cached. Driven by the daemon
 * background loop so a record exists for `session list -d` / restart even
 * when no client is polling /session/list (the only other trigger).
 *
 * Short-circuits on a cheap meta-file read once captured, so steady-state
 * ticks don't re-probe settled sessions. Probing only persists when
 * opencode has generated a title (i.e. a message was submitted), so this
 * preserves parity with claude/codex — a session with no messages yet
 * leaves no record.
 */
export async function ensureOpencodeFirstMessageCaptured(
  projectSlug: string,
  sessionId: string,
  jobName: string,
): Promise<void> {
  const meta = await loadOpencodeMeta(projectSlug, sessionId)
  if (meta?.firstMessage) return
  await getSessionOpencodeFirstUserMessage(projectSlug, sessionId, jobName)
}
