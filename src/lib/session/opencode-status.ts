import fs from 'node:fs/promises'
import { podmanExecWithRetry, shellPodmanWithRetry } from '@/lib/container/runtime'
import { opencodeMetaFile } from '@/lib/project/paths'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import type { OpencodeSessionMeta } from '@/shared/types'

/**
 * Status + first-message lookup for opencode sessions.
 *
 * Status is read from the rendered tmux pane (window `yaac:opencode.0`),
 * not opencode's `/session/status` HTTP endpoint. The HTTP `type` field
 * (`idle` | `busy` | `retry`) stays at `busy` while opencode is paused on
 * a tool-permission prompt or a question-tool prompt — both states where
 * yaac should report `waiting`. Pane content carries unambiguous markers
 * for each.
 *
 * First-message lookup still goes through the HTTP server: opencode
 * auto-populates `session.title` from the first user prompt, which is
 * what the TUI's own switcher displays — using it here keeps the two
 * views consistent.
 */

const OPENCODE_PROBE_TTL_MS = 2_000
const OPENCODE_STATUS_TTL_MS = 2_000
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

type StatusEntry =
  | { kind: 'settled'; value: 'running' | 'waiting'; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<'running' | 'waiting'> }

function probeCacheKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

const probeCache = new Map<string, ProbeEntry>()
const statusCache = new Map<string, StatusEntry>()

/**
 * Test-only: drop every cached entry between cases.
 */
export function _clearOpencodeProbeCacheForTests(): void {
  probeCache.clear()
  statusCache.clear()
}

/**
 * Drop the cached entries for one session. Called from cleanup.ts when
 * a session is torn down so a subsequent caller doesn't see a stale
 * probe from a brand-new session that reuses the same id (e.g. on
 * restart). Keyed by (slug, sessionId) — matches the
 * claude-status / tmux-alive eviction signature.
 */
export function evictOpencodeProbeCache(slug: string, sessionId: string): void {
  const key = probeCacheKey(slug, sessionId)
  probeCache.delete(key)
  statusCache.delete(key)
}

/**
 * Classify a captured opencode tmux pane into `running` / `waiting`.
 *
 * Signals (checked in priority order):
 *   1. `Permission required` — the permission overlay is up. Rendered
 *      from `routes/session/permission.tsx` as both a header label and
 *      the prompt title; appears twice. → `waiting`.
 *   2. `esc dismiss` — the question-tool overlay is up. Rendered from
 *      `routes/session/question.tsx` as the footer hint; unique to
 *      that component in opencode's TUI. → `waiting`.
 *   3. `esc interrupt` (or `esc again to interrupt` after one ESC) —
 *      rendered from `prompt/index.tsx` whenever opencode's session
 *      status is non-idle (the model/tool is actively working).
 *      → `running`.
 *   4. Otherwise → `waiting` (idle, or any state where opencode hasn't
 *      rendered a busy/dialog marker yet, e.g. mid-startup).
 *
 * Overlays render on top of the prompt area, so the busy hint can be
 * visible underneath them — that's why the dialog signals take
 * precedence over the interrupt hint.
 */
const PERMISSION_HINT = /Permission required/i
const QUESTION_HINT = /esc\s+dismiss/i
const INTERRUPT_HINT = /esc\s+(?:again\s+to\s+)?interrupt/i

export function classifyOpencodePane(paneContent: string): 'running' | 'waiting' {
  if (PERMISSION_HINT.test(paneContent)) return 'waiting'
  if (QUESTION_HINT.test(paneContent)) return 'waiting'
  if (INTERRUPT_HINT.test(paneContent)) return 'running'
  return 'waiting'
}

/**
 * Capture the visible portion of the opencode agent pane as plain text
 * via `tmux capture-pane -p`. The `-J` flag joins wrapped lines so
 * wide-terminal wrapping never splits a hint across rows. Returns
 * `undefined` if the container or tmux session isn't ready yet (e.g.
 * mid-startup) — caller falls back to `waiting`.
 */
async function captureOpencodePane(containerName: string): Promise<string | undefined> {
  try {
    const { stdout } = await shellPodmanWithRetry(
      `podman exec ${containerName} tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -pJ -t yaac:opencode.0`,
      { maxAttempts: 1 },
    )
    return stdout
  } catch {
    return undefined
  }
}

async function runProbe(containerName: string): Promise<OpencodeProbe | null> {
  // One podman exec → curl /session. -sf suppresses output on curl
  // failure (HTTP server not up yet, etc.); we then see empty/non-JSON
  // below and return null.
  let stdout: string
  try {
    const result = await podmanExecWithRetry(
      ['exec', containerName, 'curl', '-sf', 'http://127.0.0.1:4096/session'],
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
 * (slug, sessionId) so a restart that reuses the same container name
 * doesn't accidentally read a previous-session probe.
 */
async function probeOpencode(
  slug: string,
  sessionId: string,
  containerName: string,
): Promise<OpencodeProbe | null> {
  const key = probeCacheKey(slug, sessionId)
  const now = Date.now()
  const cached = probeCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = runProbe(containerName).then((value) => {
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

async function probeOpencodeStatus(containerName: string): Promise<'running' | 'waiting'> {
  const pane = await captureOpencodePane(containerName)
  if (pane === undefined) return 'waiting'
  return classifyOpencodePane(pane)
}

/**
 * Status for an opencode session, derived from the rendered tmux pane.
 * When pane capture fails (container just started, tmux server not up
 * yet, etc.) defaults to 'waiting' — matches the claude-status fallback.
 *
 * Concurrent callers coalesce onto one capture-pane exec via the
 * short-TTL `statusCache`. Without this, `/session/list` (UI polls
 * every ~5s), `getWaitingSessions` (called from the stream picker),
 * and any overlap between them each drive their own `podman exec`
 * independently for every opencode session.
 */
export async function getSessionOpencodeStatus(
  projectSlug: string,
  sessionId: string,
  containerName: string,
): Promise<'running' | 'waiting'> {
  const key = probeCacheKey(projectSlug, sessionId)
  const now = Date.now()
  const cached = statusCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeOpencodeStatus(containerName).then((value) => {
    statusCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + OPENCODE_STATUS_TTL_MS,
    })
    return value
  })
  statusCache.set(key, { kind: 'inflight', promise })
  return promise
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
  containerName: string,
): Promise<string | undefined> {
  // Probe the live container first to pick up any title updates that
  // happened since we last cached.
  const probe = await probeOpencode(projectSlug, sessionId, containerName)
  const session = probe ? pickOpencodeSession(probe) : undefined
  if (session?.title) {
    await saveOpencodeMeta(projectSlug, sessionId, {
      firstMessage: session.title,
      capturedAt: new Date().toISOString(),
    })
    return session.title
  }
  // Container gone or no session yet — fall back to the cached snapshot.
  const meta = await loadOpencodeMeta(projectSlug, sessionId)
  return meta?.firstMessage
}

/**
 * Deleted-session first-message lookup: container is gone, so probe
 * isn't an option. Reads straight from the cached meta file.
 */
export async function getDeletedSessionOpencodeFirstUserMessage(
  projectSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  const meta = await loadOpencodeMeta(projectSlug, sessionId)
  return meta?.firstMessage
}
