import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { sessionExec } from '#platform/k8s/stream-relay'
import { getDb } from '#platform/db/client'
import { opencodeSessionMeta } from '#platform/db/schema'
import { listSessionPods } from '#platform/k8s/pods'
import { classifySessionPods } from '#features/sessions/classify'
import { probeTmuxLiveness } from '#features/sessions/cleanup'
import { normalizeTool } from '#features/sessions/state'
import { testEnv } from '@yaac/shared/env'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import type { OpencodeSessionMeta } from '@yaac/shared/types'

/**
 * Status markers + first-message lookup for opencode sessions.
 *
 * Status is read from the rendered tmux pane (window `yaac:opencode.0`),
 * not opencode's `/session/status` HTTP endpoint. The HTTP `type` field
 * (`idle` | `busy` | `retry`) stays at `busy` while opencode is paused on
 * a tool-permission prompt or a question-tool prompt — both states where
 * yaac should report `waiting`. The pane carries unambiguous markers for
 * each. The busy/idle classification runs *inside tmux*: the session's
 * status watcher (`src/server/status-watcher.ts`) subscribes to a format
 * built from `OPENCODE_BUSY_MARKERS`, so only the resolved word crosses
 * the control-mode stream — the rendered pane never does.
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
 * Busy markers for an opencode pane, as tmux ERE patterns (see
 * `busyStatusFormat` in status-watcher.ts). Any match in the visible pane
 * means `running`; none means `waiting`.
 *
 * While a turn is in flight the footer status line renders an animated
 * strip of ■/⬝ cells followed by the interrupt hint ("esc interrupt", or
 * "esc again to interrupt" after one ESC) — either marker means `running`.
 * Everything else is `waiting`: the status line only exists when no footer
 * panel is open (`footer.view.tsx` renders it under `!panel() && !menu()`),
 * and permission / question dialogs are panels, so a dialog *replaces* the
 * busy markers rather than overlaying them — a user-blocked pane simply
 * carries neither signal (verified against opencode 1.17.11: a busy footer
 * reads e.g. "■■■■■⬝⬝⬝  esc interrupt").
 *
 * tmux-ERE constraints (matched case-insensitively via `#{C/ri:}`): use
 * `(...)` not `(?:...)`, and spell repetition out — a `{n,}` interval's `}`
 * would close the surrounding `#{...}`. The busy strip is therefore four
 * explicit ■/⬝ cells (four-or-more, since the search is unanchored).
 */
export const OPENCODE_BUSY_MARKERS: readonly string[] = [
  'esc\\s+(again\\s+to\\s+)?interrupt',
  '[■⬝][■⬝][■⬝][■⬝]',
]

async function runProbe(jobName: string): Promise<OpencodeProbe | null> {
  // One relay exec → curl /session. -sf suppresses output on curl
  // failure (HTTP server not up yet, etc.); we then see empty/non-JSON
  // below and return null.
  let stdout: string
  try {
    const result = await sessionExec(
      jobName,
      'curl -sf http://127.0.0.1:4096/session',
      { maxAttempts: 2, timeout: PROBE_TIMEOUT_MS },
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
  const db = await getDb()
  const rows = await db.select().from(opencodeSessionMeta).where(and(
    eq(opencodeSessionMeta.projectSlug, projectSlug),
    eq(opencodeSessionMeta.sessionId, sessionId),
  ))
  const row = rows[0]
  if (!row) return null
  const result: OpencodeSessionMeta = {}
  if (row.firstMessage !== null) result.firstMessage = row.firstMessage
  if (row.capturedAt !== null) result.capturedAt = row.capturedAt
  return result
}

/** Persist a first-message snapshot. Exported for test seeding — production
 *  writes all come from getSessionOpencodeFirstUserMessage. */
export async function saveOpencodeMeta(
  projectSlug: string,
  sessionId: string,
  meta: OpencodeSessionMeta,
): Promise<void> {
  try {
    const db = await getDb()
    const values = {
      firstMessage: meta.firstMessage ?? null,
      capturedAt: meta.capturedAt ?? null,
    }
    await db.insert(opencodeSessionMeta)
      .values({ projectSlug, sessionId, ...values })
      .onConflictDoUpdate({
        target: [opencodeSessionMeta.projectSlug, opencodeSessionMeta.sessionId],
        set: values,
      })
  } catch {
    // Non-fatal: meta caching is for deleted-session lookups; if we
    // can't write, getSessionOpencodeFirstUserMessage just falls back
    // to re-probing next time.
  }
}

/** Whether a first-message snapshot exists — the marker that a session ran
 *  opencode, used by restart's tool inference once the pod is gone. */
export async function hasOpencodeMeta(projectSlug: string, sessionId: string): Promise<boolean> {
  return (await loadOpencodeMeta(projectSlug, sessionId)) !== null
}

/** All snapshots for a project, with when each was first captured — the
 *  opencode arm of deleted-session listing (claude/codex list transcript
 *  files; opencode sessions leave no transcript on the host). */
export async function listOpencodeMetaEntries(
  slug: string,
): Promise<Array<{ sessionId: string; createdAt: Date; capturedAt: string | null }>> {
  const db = await getDb()
  return db.select({
    sessionId: opencodeSessionMeta.sessionId,
    createdAt: opencodeSessionMeta.createdAt,
    capturedAt: opencodeSessionMeta.capturedAt,
  }).from(opencodeSessionMeta).where(eq(opencodeSessionMeta.projectSlug, slug))
}

/**
 * First user message for an opencode session, used by `yaac session
 * list` to show a prompt preview. opencode auto-generates
 * `session.title` from the first prompt, which is what the TUI's own
 * session switcher displays — using it here keeps the two views in
 * sync.
 *
 * Successful captures are persisted to the DB so subsequent lookups
 * (including for deleted sessions whose container is gone) return the
 * cached value without needing to re-probe.
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
 * isn't an option. Reads straight from the cached snapshot.
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
 * session, but only if one isn't already cached. Driven by the server
 * reconciler so a record exists for `session list -d` / restart even
 * when no client is polling /session/list (the only other trigger).
 *
 * Short-circuits on a cheap meta read once captured, so steady-state
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

/**
 * Persist the first-message snapshot for running opencode sessions that
 * don't have one yet, so `session list -d` and restart retain a record
 * even when no client polls /session/list (otherwise the only trigger).
 * Designed to run from the server reconciler.
 *
 * opencode is the only tool whose snapshot is probe-driven — claude and
 * codex write their transcripts directly on message submit — so this
 * targets opencode sessions and is a no-op for the rest. Each capture
 * is best-effort and self-skips once a snapshot exists (see
 * `ensureOpencodeFirstMessageCaptured`).
 */
export async function captureOpencodeFirstMessages(snapshot?: TickSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }
  const { running } = await classifySessionPods(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )
  await Promise.all(running.map(async (p) => {
    if (normalizeTool(p.tool) !== 'opencode') return
    if (!p.sessionId || !p.projectSlug || !p.jobName) return
    try {
      await ensureOpencodeFirstMessageCaptured(p.projectSlug, p.sessionId, p.jobName)
    } catch {
      // best-effort — next tick retries
    }
  }))
}

// ---------------------------------------------------------------------------
// Config seeding
// ---------------------------------------------------------------------------

interface OpencodeConfig {
  permission?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Ensures the shared opencode.json grants the websearch permission so
 * opencode's Exa-backed websearch tool is usable. Merges with any
 * existing keys rather than overwriting — opencode itself writes to
 * this file via `Config.updateGlobal()` (model selection, etc.).
 *
 * The tool is also gated on `OPENCODE_ENABLE_EXA=true` in the
 * container env; without that env var the tool isn't registered no
 * matter what the permission says.
 */
export async function ensureOpencodeConfigJson(
  opencodeConfigDir: string,
): Promise<void> {
  const configPath = path.join(opencodeConfigDir, 'opencode.json')

  let config: OpencodeConfig = {}
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as OpencodeConfig
    }
  } catch {
    // No existing config or invalid — start fresh
  }

  const permission: Record<string, unknown> = config.permission ?? {}
  if (permission.websearch === 'allow') return

  permission.websearch = 'allow'
  config.permission = permission
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
}
