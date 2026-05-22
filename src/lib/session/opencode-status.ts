import fs from 'node:fs/promises'
import { podmanExecWithRetry } from '@/lib/container/runtime'
import { opencodeMetaFile } from '@/lib/project/paths'
import type { OpencodeSessionMeta } from '@/shared/types'

/**
 * Status + first-message lookup for opencode sessions.
 *
 * opencode's TUI has no stable "interrupt" hint we can pane-scrape for
 * busy/idle classification, and no JSONL transcript file we can tail.
 * It does run a built-in HTTP server when launched with `--port` (see
 * buildAgentCmd in daemon/session-create.ts), so we query its
 * `/session` and `/session/status` endpoints via `podman exec curl` for
 * both status and first-message lookup.
 *
 * `first-message` is cached to `opencodeMetaFile(slug, sessionId)` on
 * each successful capture so `yaac session list -d` (deleted sessions,
 * container gone) still has something to show.
 */

const OPENCODE_STATUS_TTL_MS = 2_000
const PROBE_TIMEOUT_MS = 3000
const PROBE_SEPARATOR = '<<<yaac-opencode-probe-sep>>>'

interface OpencodeProbe {
  sessions: OpencodeSessionRow[]
  status: Record<string, OpencodeStatus>
}

interface OpencodeSessionRow {
  id: string
  title?: string
  directory?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

interface OpencodeStatus {
  // opencode's documented states are 'idle' | 'busy' | 'retry'. Typed as
  // `string` so an upstream addition like 'starting' doesn't make the
  // probe parser return null — unknown states fall through to 'waiting'
  // in classifyStatus.
  type: string
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
 * restart). Keyed by (slug, sessionId) — matches the
 * claude-status / tmux-alive eviction signature.
 */
export function evictOpencodeProbeCache(slug: string, sessionId: string): void {
  probeCache.delete(probeCacheKey(slug, sessionId))
}

async function runProbe(containerName: string): Promise<OpencodeProbe | null> {
  // One podman exec, two curl calls, split by a unique separator so we
  // can deserialize both JSON blobs in a single round-trip. -sf suppresses
  // output on curl failure (HTTP server not up yet, etc.); we then see
  // empty/non-JSON below and return null.
  const cmd = `curl -sf http://127.0.0.1:4096/session; echo '${PROBE_SEPARATOR}'; curl -sf http://127.0.0.1:4096/session/status`
  let stdout: string
  try {
    const result = await podmanExecWithRetry(
      ['exec', containerName, 'sh', '-c', cmd],
      { maxAttempts: 2, baseDelay: 100, timeout: PROBE_TIMEOUT_MS },
    )
    stdout = result.stdout
  } catch {
    return null
  }

  const [sessionsRaw, statusRaw] = stdout.split(PROBE_SEPARATOR)
  if (!sessionsRaw || !statusRaw) return null

  let sessions: OpencodeSessionRow[]
  let status: Record<string, OpencodeStatus>
  try {
    const parsedSessions: unknown = JSON.parse(sessionsRaw.trim())
    if (!Array.isArray(parsedSessions)) return null
    sessions = parsedSessions as OpencodeSessionRow[]

    const parsedStatus: unknown = JSON.parse(statusRaw.trim())
    if (!parsedStatus || typeof parsedStatus !== 'object' || Array.isArray(parsedStatus)) return null
    status = parsedStatus as Record<string, OpencodeStatus>
  } catch {
    return null
  }
  return { sessions, status }
}

/**
 * Coalesce concurrent probes against the same session into one exec
 * and cache the result for OPENCODE_STATUS_TTL_MS. Mirrors the
 * Claude-status caching pattern — keyed by (slug, sessionId) so a
 * restart that reuses the same container name doesn't accidentally
 * read a previous-session probe.
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
      expiresAt: Date.now() + OPENCODE_STATUS_TTL_MS,
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

function classifyStatus(s: OpencodeStatus | undefined): 'running' | 'waiting' {
  if (!s) return 'waiting'
  if (s.type === 'busy' || s.type === 'retry') return 'running'
  return 'waiting'
}

/**
 * Status for an opencode session. Maps opencode's session.status (busy /
 * retry / idle) to yaac's (running / waiting). When the HTTP server
 * isn't reachable (container just started, probe failed, etc.) defaults
 * to 'waiting' — matches the Claude-status fallback when pane capture
 * fails.
 */
export async function getSessionOpencodeStatus(
  projectSlug: string,
  sessionId: string,
  containerName: string,
): Promise<'running' | 'waiting'> {
  const probe = await probeOpencode(projectSlug, sessionId, containerName)
  if (!probe) return 'waiting'
  const session = pickOpencodeSession(probe)
  if (!session) return 'waiting'
  return classifyStatus(probe.status[session.id])
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
