import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionJobs, listSessionPods, isPrewarmed, type SessionPod } from '@/lib/k8s/pods'
import { claudeDir, codexTranscriptDir, getProjectsDir, opencodeMetaDir, projectDir } from '@/lib/project/paths'
import { getSessionStatus, getSessionFirstMessage, normalizeTool } from '@/lib/session/status'
import { ensureOpencodeFirstMessageCaptured } from '@/lib/session/opencode-status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import { getSessionTitles } from '@/lib/session/titles'
import { DaemonError } from '@/daemon/errors'
import type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  SessionListEntry,
  StaleSessionInfo,
} from '@/shared/types'

export type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  SessionListEntry,
  StaleSessionInfo,
}

/**
 * Default grace window that protects freshly-created session pods from
 * the stale-session reaper. session-create's retry loop recreates the
 * Job between attempts and does not start tmux until the last step, so
 * without a grace period a concurrent `listActiveSessions` call can
 * classify the pod as a zombie — firing cleanupSessionDetached, which
 * removes the session's allowedHosts from the proxy mid-creation.
 * Tests override this with YAAC_STARTING_GRACE_MS so they can provoke
 * cleanup on sessions they just created.
 */
export const STARTING_GRACE_MS = 60_000

export function resolveStartingGraceMs(): number {
  const raw = process.env.YAAC_STARTING_GRACE_MS
  if (raw === undefined || raw === '') return STARTING_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : STARTING_GRACE_MS
}

/**
 * Split the pod list into the ones the renderer should show as active
 * sessions, the ones the caller should tear down, and implicitly (by
 * omission) the ones that are still inside the startup grace window.
 */
export async function classifySessionPods(
  pods: SessionPod[],
  nowMs: number,
  isTmuxAlive: (slug: string, sessionId: string) => Promise<boolean>,
  graceMs: number = STARTING_GRACE_MS,
): Promise<{ running: SessionPod[]; stale: StaleSessionInfo[] }> {
  const running: SessionPod[] = []
  const stale: StaleSessionInfo[] = []
  for (const p of pods) {
    if (p.running && p.projectSlug && p.sessionId && await isTmuxAlive(p.projectSlug, p.sessionId)) {
      running.push(p)
      continue
    }

    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue

    const zombie = p.running
    stale.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId, zombie })
  }
  return { running, stale }
}

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
  }
}

function formatCreated(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * In-flight `listActiveSessions` calls keyed by `projectFilter ?? ''`.
 * The UI polls /session/list every ~5s and `listActiveSessions` is the
 * heaviest read path (pod list + N tmux-alive probes + N status
 * reads), so overlapping requests must share one execution. Each entry
 * is cleared when its Promise settles.
 */
const listActiveInflight = new Map<string, Promise<ActiveSessionsResult>>()

/**
 * Test-only: drop in-flight state so test cases that mock different
 * underlying behavior don't see each other's shared promise.
 */
export function _clearListActiveInflightForTests(): void {
  listActiveInflight.clear()
}

/**
 * Enumerate session pods for a project (or all projects), splitting
 * them into the active-session rows the renderer displays and the stale
 * set the caller is expected to tear down.
 *
 * Concurrent calls with the same `projectFilter` share one in-flight
 * Promise (see `listActiveInflight`).
 */
export async function listActiveSessions(projectFilter?: string): Promise<ActiveSessionsResult> {
  const key = projectFilter ?? ''
  const existing = listActiveInflight.get(key)
  if (existing) return existing
  const promise = listActiveSessionsImpl(projectFilter).finally(() => {
    listActiveInflight.delete(key)
  })
  listActiveInflight.set(key, promise)
  return promise
}

async function listActiveSessionsImpl(projectFilter?: string): Promise<ActiveSessionsResult> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  let pods
  try {
    pods = await listSessionPods(projectFilter)
  } catch (err) {
    throw new DaemonError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  // Prewarmed spares are not user sessions until claimed — hide them from the
  // session list (and skip the status/first-message probes they'd trigger).
  // The stale reaper deliberately still sees them (it lists pods itself), so a
  // stuck spare is still reaped.
  pods = pods.filter((p) => !isPrewarmed(p))

  const { running, stale } = await classifySessionPods(
    pods, Date.now(), isTmuxSessionAlive, resolveStartingGraceMs(),
  )

  // User-assigned titles, one file read per project.
  const titleSlugs = [...new Set(running.map((p) => p.projectSlug).filter((v): v is string => !!v))]
  const titlesBySlug = new Map(await Promise.all(
    titleSlugs.map(async (slug) => [slug, await getSessionTitles(slug)] as const),
  ))

  const sessions: SessionListEntry[] = await Promise.all(
    running.map(async (p): Promise<SessionListEntry> => {
      const tool = normalizeTool(p.tool)
      if (!p.sessionId || !p.projectSlug) {
        return {
          sessionId: p.sessionId,
          projectSlug: p.projectSlug,
          tool,
          status: 'running',
          createdAt: formatCreated(p.createdAtMs),
          blockedHosts: [],
        }
      }
      const [status, prompt, blockedHosts] = await Promise.all([
        getSessionStatus(p.projectSlug, p.sessionId, tool, p.jobName),
        getSessionFirstMessage(p.projectSlug, p.sessionId, tool, p.jobName),
        readBlockedHosts(p.sessionId),
      ])
      return {
        sessionId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        status,
        createdAt: formatCreated(p.createdAtMs),
        prompt,
        title: titlesBySlug.get(p.projectSlug)?.[p.sessionId],
        blockedHosts,
      }
    }),
  )

  return { sessions, stale }
}

/**
 * Tear down stale session Jobs (pod stopped, or running with a dead
 * tmux session) across every project. Swallows individual failures so
 * one broken session can't block the rest; designed to be called from
 * the daemon background loop.
 */
export async function reconcileStaleSessions(): Promise<void> {
  let pods
  try {
    pods = await listSessionPods()
  } catch {
    return
  }
  const nowMs = Date.now()
  const graceMs = resolveStartingGraceMs()
  const { stale } = await classifySessionPods(pods, nowMs, isTmuxSessionAlive, graceMs)

  // Orphan-Job sweep: a Job whose pod was evicted/deleted out-of-band is
  // invisible to the pod-based classifier, so cross-reference the Job
  // list and reap any job past the grace window with no backing pod.
  const orphanTargets: Array<{ jobName: string; projectSlug: string; sessionId: string }> = []
  try {
    const jobs = await listSessionJobs()
    const podSessionIds = new Set(pods.map((p) => p.sessionId))
    for (const j of jobs) {
      if (podSessionIds.has(j.sessionId)) continue
      if (nowMs - j.createdAtMs < graceMs) continue
      orphanTargets.push({ jobName: j.jobName, projectSlug: j.projectSlug, sessionId: j.sessionId })
    }
  } catch {
    // Job list unavailable — the pod-based sweep below still runs.
  }

  const targets = [
    ...stale.map((s) => ({ jobName: s.jobName, projectSlug: s.projectSlug, sessionId: s.sessionId })),
    ...orphanTargets,
  ]
  if (targets.length === 0) return
  await Promise.all(targets.map((t) =>
    cleanupSessionDetached(t).catch(() => { /* best-effort */ }),
  ))
}

/**
 * Persist the first-message snapshot for running opencode sessions that
 * don't have one yet, so `session list -d` and restart retain a record
 * even when no client polls /session/list (otherwise the only trigger).
 * Designed to run from the daemon background loop.
 *
 * opencode is the only tool whose snapshot is probe-driven — claude and
 * codex write their transcripts directly on message submit — so this
 * targets opencode sessions and is a no-op for the rest. Each capture
 * is best-effort and self-skips once a snapshot exists (see
 * `ensureOpencodeFirstMessageCaptured`).
 */
export async function captureOpencodeFirstMessages(): Promise<void> {
  let pods
  try {
    pods = await listSessionPods()
  } catch {
    return
  }
  const { running } = await classifySessionPods(
    pods, Date.now(), isTmuxSessionAlive, resolveStartingGraceMs(),
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

/**
 * Scan the Claude Code JSONL dirs, Codex transcript dirs, and opencode
 * meta caches for session ids that no longer have a matching session
 * pod. If the cluster is not reachable, every saved session is treated
 * as deleted.
 *
 * Entries are sorted newest-first and sliced to `limit` before prompts
 * are read — parsing each JSONL only for the rows the caller will render.
 * Pass `undefined` / `0` to disable the limit.
 */
export async function listDeletedSessions(
  projectFilter?: string,
  limit?: number,
): Promise<DeletedSessionEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const slugs: string[] = []
  if (projectFilter) {
    slugs.push(projectFilter)
  } else {
    try {
      const entries = await fs.readdir(getProjectsDir())
      slugs.push(...entries)
    } catch {
      return []
    }
  }

  const activeSessionIds = new Set<string>()
  try {
    const pods = await listSessionPods()
    for (const p of pods) {
      if (p.sessionId) activeSessionIds.add(p.sessionId)
    }
  } catch {
    // cluster not reachable — treat all as deleted
  }

  // Track ms-precision birthtime alongside each entry so the sort is
  // stable across files created in the same second (createdAt is
  // truncated to second precision for display).
  const collected: Array<{ entry: DeletedSessionEntry; birthtimeMs: number }> = []

  for (const slug of slugs) {
    const claudeSessionsDir = path.join(claudeDir(slug), 'projects', '-workspace')
    try {
      const files = await fs.readdir(claudeSessionsDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        try {
          const stat = await fs.stat(path.join(claudeSessionsDir, file))
          collected.push({
            entry: {
              sessionId,
              projectSlug: slug,
              tool: 'claude',
              createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
            },
            birthtimeMs: stat.birthtimeMs,
          })
        } catch {
          continue
        }
      }
    } catch {
      // no claude sessions dir
    }

    const codexTranscripts = codexTranscriptDir(slug)
    try {
      const entries = await fs.readdir(codexTranscripts)
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        const sessionId = entry.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        const filePath = path.join(codexTranscripts, entry)
        try {
          const stat = await fs.lstat(filePath)
          collected.push({
            entry: {
              sessionId,
              projectSlug: slug,
              tool: 'codex',
              createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
            },
            birthtimeMs: stat.birthtimeMs,
          })
        } catch {
          continue
        }
      }
    } catch {
      // no codex transcript dir
    }

    // opencode's per-session sqlite data dir is created for every
    // session regardless of tool, so it can't identify opencode
    // sessions. The meta cache (first-message snapshot, keyed by
    // session id) is written only for opencode sessions and survives
    // container teardown, making it the authoritative deleted-session
    // record — the same source getDeletedSessionOpencodeFirstUserMessage
    // reads from.
    const opencodeMeta = opencodeMetaDir(slug)
    try {
      const entries = await fs.readdir(opencodeMeta)
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const sessionId = entry.replace('.json', '')
        if (activeSessionIds.has(sessionId)) continue
        const filePath = path.join(opencodeMeta, entry)
        try {
          const stat = await fs.lstat(filePath)
          collected.push({
            entry: {
              sessionId,
              projectSlug: slug,
              tool: 'opencode',
              createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
            },
            birthtimeMs: stat.birthtimeMs,
          })
        } catch {
          continue
        }
      }
    } catch {
      // no opencode meta dir
    }
  }

  collected.sort((a, b) => b.birthtimeMs - a.birthtimeMs)
  const slice = limit && limit > 0 ? collected.slice(0, limit) : collected
  const capped = slice.map((r) => r.entry)
  const deletedTitleSlugs = [...new Set(capped.map((e) => e.projectSlug))]
  const deletedTitles = new Map(await Promise.all(
    deletedTitleSlugs.map(async (slug) => [slug, await getSessionTitles(slug)] as const),
  ))
  await Promise.all(capped.map(async (entry) => {
    entry.prompt = await getSessionFirstMessage(entry.projectSlug, entry.sessionId, entry.tool)
    entry.title = deletedTitles.get(entry.projectSlug)?.[entry.sessionId]
  }))
  return capped
}
