import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionJobs, listSessionPods, isPrewarmed, type SessionPod } from '#lib/k8s/pods'
import { getActivePodWatcher } from '#lib/k8s/pod-watch'
import { worktreeUpstreamBranch } from '#lib/git'
import { claudeDir, codexTranscriptDir, getProjectsDir, projectDir, repoDir } from '@yaac/shared/project-paths'
import { getSessionFirstMessage, normalizeTool } from '#lib/session/status'
import { ensureOpencodeFirstMessageCaptured, listOpencodeMetaEntries } from '#lib/session/opencode-status'
import { listDeletedAt } from '#lib/session/deleted-store'
import { isSessionTerminating, pruneTerminating } from '#lib/session/terminating'
import { isSessionStreamHealthy, readSessionStatus, readSessionWaitingSince } from '#lib/session/status-store'
import { probeAgentPaneState, probeTmuxLiveness, cleanupSessionDetached, type TmuxLiveness } from '#lib/session/cleanup'
import { getSessionPorts } from '#lib/session/port-forwarders'
import { readBlockedHosts } from '#lib/session/blocked-hosts'
import { readAllGitAuthFailures } from '#lib/project/git-auth-failures'
import { getSessionTitles } from '#lib/session/titles'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import { testEnv } from '@yaac/shared/env'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  SessionListEntry,
  StaleSessionInfo,
} from '@yaac/shared/types'

export type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  SessionListEntry,
  StaleSessionInfo,
}

/**
 * Split the pod list into the ones the renderer should show as active
 * sessions, the ones the caller should tear down, and implicitly (by
 * omission) the ones that are still inside the startup grace window.
 * Production callers pass `testEnv.startingGraceMs` for `graceMs`.
 */
export async function classifySessionPods(
  pods: SessionPod[],
  nowMs: number,
  probeLiveness: (slug: string, sessionId: string) => Promise<TmuxLiveness>,
  graceMs: number,
): Promise<{
  running: SessionPod[]
  stale: StaleSessionInfo[]
  indeterminate: SessionPod[]
  terminating: SessionPod[]
}> {
  const running: SessionPod[] = []
  const stale: StaleSessionInfo[] = []
  const indeterminate: SessionPod[] = []
  const terminating: SessionPod[] = []
  for (const p of pods) {
    // A pod on its way out (deletionTimestamp set, or a delete just issued)
    // is neither active nor stale: it renders as a "terminating…" row and is
    // already being torn down, so keep it out of both the probe path and the
    // reaper's targets.
    if (p.terminating || (!!p.sessionId && isSessionTerminating(p.sessionId))) {
      terminating.push(p)
      continue
    }
    if (p.running && p.projectSlug && p.sessionId) {
      const liveness = await probeLiveness(p.projectSlug, p.sessionId)
      if (liveness === 'alive') {
        running.push(p)
        continue
      }
      if (liveness === 'unknown') {
        // Inconclusive probe on a still-running pod — keep it. Reaping
        // here on a transient kubectl-exec failure would destroy a
        // healthy session (Job + vcluster, no recovery). It stays in the
        // running bucket; a genuinely dead pod is still caught later by
        // the pod-phase (running=false) and orphan-Job paths.
        running.push(p)
        indeterminate.push(p)
        continue
      }
      // liveness === 'dead' — fall through to stale classification.
    }

    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue

    const zombie = p.running
    stale.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId, zombie })
  }
  return { running, stale, indeterminate, terminating }
}

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  }
}

/**
 * Display-path tmux liveness, fed by the status watchers instead of a
 * probe: a healthy control-mode stream is conclusive proof the in-pod
 * tmux server is up; anything else is merely `unknown` (watcher still
 * connecting, respawning after a blip, server just started). Never
 * `dead` — display must not drop a session on stream state. Genuinely
 * dead sessions leave the list when their pod goes away (pod watch) or
 * when the stale reaper — which keeps its own conclusive probes —
 * tears them down.
 */
function watcherDisplayLiveness(slug: string, sessionId: string): Promise<TmuxLiveness> {
  return Promise.resolve(isSessionStreamHealthy(slug, sessionId) ? 'alive' : 'unknown')
}

/**
 * In-flight `listActiveSessions` calls keyed by `projectFilter ?? ''`.
 * The UI polls /session/list every ~5s; overlapping requests share one
 * execution. Each entry is cleared when its Promise settles.
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

  // In the server the pod watcher's push-fed cache answers instantly;
  // the one-shot kubectl list is the fallback for watcher-less contexts
  // (unit tests, a watcher that hasn't started yet).
  const watcher = getActivePodWatcher()
  let pods
  if (watcher) {
    pods = watcher.getPods(projectFilter)
  } else {
    try {
      pods = await listSessionPods(projectFilter)
    } catch (err) {
      throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
    }
  }

  // Prewarmed spares are not user sessions until claimed — hide them from the
  // session list (and skip the status/first-message reads they'd trigger).
  // The stale reaper deliberately still sees them (it lists pods itself), so a
  // stuck spare is still reaped.
  pods = pods.filter((p) => !isPrewarmed(p))

  const { running, stale, terminating } = await classifySessionPods(
    pods, Date.now(), watcherDisplayLiveness, testEnv.startingGraceMs,
  )

  // Forget terminating marks whose pod is gone (teardown finished) or that
  // outlived the TTL (a failed teardown), so the set can't leak or strand a
  // permanently-greyed row.
  pruneTerminating(new Set(pods.map((p) => p.sessionId).filter((v): v is string => !!v)), Date.now())

  // User-assigned titles, one file read per project — for both live and
  // terminating rows (the latter keep their title on the way out).
  const titleSlugs = [...new Set(
    [...running, ...terminating].map((p) => p.projectSlug).filter((v): v is string => !!v),
  )]
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
          createdAt: formatUtcTimestamp(p.createdAtMs),
          blockedHosts: [],
          forwardedPorts: [],
        }
      }
      const [prompt, blockedHosts, baseBranch] = await Promise.all([
        getSessionFirstMessage(p.projectSlug, p.sessionId, tool, p.jobName),
        readBlockedHosts(p.sessionId),
        // The session branch's recorded upstream (branch.agent/<id>.merge in
        // the shared repo config) — written at setup, rewritten by a claim's
        // re-branch prep, so it's authoritative for a listed session.
        worktreeUpstreamBranch(repoDir(p.projectSlug), `agent/${p.sessionId}`).catch(() => null),
      ])
      return {
        sessionId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        status: readSessionStatus(p.projectSlug, p.sessionId),
        createdAt: formatUtcTimestamp(p.createdAtMs),
        waitingSinceMs: readSessionWaitingSince(p.projectSlug, p.sessionId),
        prompt,
        title: titlesBySlug.get(p.projectSlug)?.[p.sessionId],
        blockedHosts,
        forwardedPorts: getSessionPorts(p.sessionId),
        baseBranch: baseBranch ?? undefined,
      }
    }),
  )

  // Terminating rows: a distinct, non-interactive placeholder. Status is
  // forced to 'running' (never read from the status store, which was evicted
  // at teardown and would default to 'waiting' — the flash we're killing) and
  // waitingSinceMs is omitted, so no attention badge fires. The first-message
  // read is the cached-transcript overload (no jobName) so it never probes the
  // dying container.
  const terminatingRows: SessionListEntry[] = await Promise.all(
    terminating.map(async (p): Promise<SessionListEntry> => {
      const tool = normalizeTool(p.tool)
      const prompt = p.sessionId && p.projectSlug
        ? await getSessionFirstMessage(p.projectSlug, p.sessionId, tool)
        : undefined
      return {
        sessionId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        status: 'running',
        terminating: true,
        createdAt: formatUtcTimestamp(p.createdAtMs),
        prompt,
        title: p.projectSlug ? titlesBySlug.get(p.projectSlug)?.[p.sessionId] : undefined,
        blockedHosts: [],
        forwardedPorts: [],
      }
    }),
  )
  sessions.push(...terminatingRows)

  // Project-wide git credential failures — independent of the session set
  // (a bad token persists with zero running sessions and blocks new ones).
  const allGitAuthFailures = await readAllGitAuthFailures()
  const gitAuthFailures = projectFilter
    ? (allGitAuthFailures[projectFilter]
      ? { [projectFilter]: allGitAuthFailures[projectFilter] }
      : {})
    : allGitAuthFailures

  return { sessions, stale, gitAuthFailures }
}

/**
 * Tear down stale session Jobs (pod stopped, or running with a dead
 * tmux session) across every project. Swallows individual failures so
 * one broken session can't block the rest; designed to be called from
 * the server background loop.
 */
export async function reconcileStaleSessions(): Promise<void> {
  let pods
  try {
    pods = await listSessionPods()
  } catch {
    return
  }
  const nowMs = Date.now()
  const graceMs = testEnv.startingGraceMs
  const { running, stale, indeterminate, terminating } = await classifySessionPods(pods, nowMs, probeTmuxLiveness, graceMs)

  // Surface the near-miss: a running pod we deliberately did NOT reap
  // because its tmux probe was inconclusive (transient kubectl-exec
  // failure) — historically the main false-positive source. Without this
  // line the avoided reap is invisible, so a flapping probe looks like
  // nothing happened.
  for (const p of indeterminate) {
    serverLog(
      `[server] stale-reaper: keeping session=${p.sessionId} job=${p.jobName}`
      + ' (tmux probe inconclusive; pod still running)',
    )
  }

  // Half-provisioned zombie sweep: a create killed between opening tmux
  // (the `sleep infinity` placeholder window) and respawning the agent —
  // e.g. a server restart mid-create — leaves a pod whose tmux is alive
  // but whose agent will never start. The liveness probe above calls that
  // healthy forever, so additionally require the agent pane to have left
  // the placeholder once the grace window has passed. Only a conclusive
  // `placeholder` verdict reaps; `unknown` keeps the session.
  const placeholderStale: StaleSessionInfo[] = []
  await Promise.all(running.map(async (p) => {
    if (!p.projectSlug || !p.sessionId) return
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) return
    if (await probeAgentPaneState(p.projectSlug, p.sessionId) !== 'placeholder') return
    placeholderStale.push({
      jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId, zombie: true,
    })
  }))

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

  // Out-of-band terminating sweep: a pod carrying a deletionTimestamp that
  // this process didn't issue (an external `kubectl delete pod`, or a delete
  // from a prior server run whose in-memory mark was lost) and that's stuck
  // past the grace window. Re-issuing the idempotent Job delete resumes the
  // teardown; deletes we issued ourselves stay marked and are skipped here.
  const stuckTerminating: Array<{ jobName: string; projectSlug: string; sessionId: string }> = []
  for (const p of terminating) {
    if (!p.terminating || !p.projectSlug || !p.sessionId) continue
    if (isSessionTerminating(p.sessionId)) continue
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue
    stuckTerminating.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId })
  }

  const targets = [
    ...stale.map((s) => ({ jobName: s.jobName, projectSlug: s.projectSlug, sessionId: s.sessionId })),
    ...placeholderStale.map((s) => ({ jobName: s.jobName, projectSlug: s.projectSlug, sessionId: s.sessionId })),
    ...orphanTargets,
    ...stuckTerminating,
  ]
  if (targets.length === 0) return

  // Audit each reap with its reason before the (detached, silent)
  // teardown runs, so a session disappearing is always explained.
  for (const s of stale) {
    const reason = s.zombie ? 'tmux gone, pod still running' : 'pod stopped'
    serverLog(`[server] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (${reason})`)
  }
  for (const s of placeholderStale) {
    serverLog(`[server] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (agent never started; placeholder pane past grace)`)
  }
  for (const o of orphanTargets) {
    serverLog(`[server] stale-reaper: reaping session=${o.sessionId} job=${o.jobName} (orphan Job, no backing pod)`)
  }
  for (const t of stuckTerminating) {
    serverLog(`[server] stale-reaper: reaping session=${t.sessionId} job=${t.jobName} (terminating out-of-band past grace)`)
  }

  await Promise.all(targets.map((t) =>
    cleanupSessionDetached(t).catch(() => { /* best-effort */ }),
  ))
}

/**
 * Persist the first-message snapshot for running opencode sessions that
 * don't have one yet, so `session list -d` and restart retain a record
 * even when no client polls /session/list (otherwise the only trigger).
 * Designed to run from the server background loop.
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
/** A deleted-session entry plus the ms-precision timestamps the listing
 *  sorts by (the entry's own strings are truncated to second precision for
 *  display). `deletedAtMs` is set only when a deletion time was recorded. */
interface CollectedDeleted {
  entry: DeletedSessionEntry
  birthtimeMs: number
  lastActiveMs: number
  deletedAtMs?: number
}

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

  /**
   * Scan one per-tool record dir for deleted-session files: readdir →
   * filter by extension → skip active session ids → stat. A missing dir
   * or an unstattable file is skipped silently. Tracks ms-precision
   * birthtime and mtime alongside each entry: mtime (last transcript
   * append) is the last-activity signal, and birthtime tiebreaks the sort
   * for entries created in the same second (createdAt is truncated to
   * second precision for display). These are server-written regular files
   * (never symlinks), so plain `fs.stat` is used.
   */
  async function collectDeleted(
    dir: string,
    ext: string,
    tool: DeletedSessionEntry['tool'],
    slug: string,
  ): Promise<CollectedDeleted[]> {
    const out: CollectedDeleted[] = []
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return out // no record dir for this tool
    }
    for (const file of files) {
      if (!file.endsWith(ext)) continue
      const sessionId = file.slice(0, -ext.length)
      if (activeSessionIds.has(sessionId)) continue
      try {
        const stat = await fs.stat(path.join(dir, file))
        out.push({
          entry: {
            sessionId,
            projectSlug: slug,
            tool,
            createdAt: formatUtcTimestamp(stat.birthtimeMs),
            lastActiveAt: formatUtcTimestamp(stat.mtimeMs),
          },
          birthtimeMs: stat.birthtimeMs,
          lastActiveMs: stat.mtimeMs,
        })
      } catch {
        continue
      }
    }
    return out
  }

  const collected: CollectedDeleted[] = []
  for (const slug of slugs) {
    collected.push(...await collectDeleted(
      path.join(claudeDir(slug), 'projects', '-workspace'), '.jsonl', 'claude', slug,
    ))
    collected.push(...await collectDeleted(codexTranscriptDir(slug), '.jsonl', 'codex', slug))
    // opencode's per-session sqlite data dir is created for every
    // session regardless of tool, so it can't identify opencode
    // sessions. The meta cache (first-message snapshot, keyed by
    // session id) is written only for opencode sessions and survives
    // container teardown, making it the authoritative deleted-session
    // record — the same source getDeletedSessionOpencodeFirstUserMessage
    // reads from. opencode leaves no host transcript, so there's no
    // per-turn activity signal: last-activity is approximated as the later
    // of the meta row's first-message capture and its creation time.
    for (const meta of await listOpencodeMetaEntries(slug)) {
      if (activeSessionIds.has(meta.sessionId)) continue
      const birthtimeMs = meta.createdAt.getTime()
      const capturedMs = meta.capturedAt ? Date.parse(meta.capturedAt) : NaN
      const lastActiveMs = Number.isNaN(capturedMs) ? birthtimeMs : Math.max(birthtimeMs, capturedMs)
      collected.push({
        entry: {
          sessionId: meta.sessionId,
          projectSlug: slug,
          tool: 'opencode',
          createdAt: formatUtcTimestamp(birthtimeMs),
          lastActiveAt: formatUtcTimestamp(lastActiveMs),
        },
        birthtimeMs,
        lastActiveMs,
      })
    }
  }

  // Enrich with recorded deletion times (the primary sort key), one query
  // per project. A session removed out-of-band has no row and falls back to
  // its last-activity time.
  const deletedAtSlugs = [...new Set(collected.map((r) => r.entry.projectSlug))]
  const deletedAtBySlug = new Map(await Promise.all(
    deletedAtSlugs.map(async (slug) => [slug, await listDeletedAt(slug)] as const),
  ))
  for (const r of collected) {
    const deletedAt = deletedAtBySlug.get(r.entry.projectSlug)?.get(r.entry.sessionId)
    if (deletedAt) {
      r.deletedAtMs = deletedAt.getTime()
      r.entry.deletedAt = formatUtcTimestamp(r.deletedAtMs)
    }
  }

  // Newest-deleted first: sort by recorded deletion time, falling back to
  // last-activity for out-of-band deletions, with birthtime as a stable
  // tiebreak within the same second.
  collected.sort((a, b) =>
    (b.deletedAtMs ?? b.lastActiveMs) - (a.deletedAtMs ?? a.lastActiveMs)
    || b.birthtimeMs - a.birthtimeMs)
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
