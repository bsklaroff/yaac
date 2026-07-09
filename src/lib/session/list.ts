import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionJobs, listSessionPods, isPrewarmed, type SessionPod } from '@/lib/k8s/pods'
import { getActivePodWatcher } from '@/lib/k8s/pod-watch'
import { claudeDir, codexTranscriptDir, getProjectsDir, opencodeMetaDir, projectDir } from '@/lib/project/paths'
import { getSessionFirstMessage, normalizeTool } from '@/lib/session/status'
import { ensureOpencodeFirstMessageCaptured } from '@/lib/session/opencode-status'
import { isSessionStreamHealthy, readSessionStatus, readSessionWaitingSince } from '@/lib/session/status-store'
import { probeAgentPaneState, probeTmuxLiveness, cleanupSessionDetached, type TmuxLiveness } from '@/lib/session/cleanup'
import { getSessionPorts } from '@/lib/session/port-forwarders'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import { readAllGitAuthFailures } from '@/lib/project/git-auth-failures'
import { getSessionTitles } from '@/lib/session/titles'
import { DaemonError } from '@/daemon/errors'
import { daemonLog } from '@/daemon/log'
import { testEnv } from '@/shared/env'
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
): Promise<{ running: SessionPod[]; stale: StaleSessionInfo[]; indeterminate: SessionPod[] }> {
  const running: SessionPod[] = []
  const stale: StaleSessionInfo[] = []
  const indeterminate: SessionPod[] = []
  for (const p of pods) {
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
  return { running, stale, indeterminate }
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
 * Display-path tmux liveness, fed by the status watchers instead of a
 * probe: a healthy control-mode stream is conclusive proof the in-pod
 * tmux server is up; anything else is merely `unknown` (watcher still
 * connecting, respawning after a blip, daemon just started). Never
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

  // In the daemon the pod watcher's push-fed cache answers instantly;
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
      throw new DaemonError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
    }
  }

  // Prewarmed spares are not user sessions until claimed — hide them from the
  // session list (and skip the status/first-message reads they'd trigger).
  // The stale reaper deliberately still sees them (it lists pods itself), so a
  // stuck spare is still reaped.
  pods = pods.filter((p) => !isPrewarmed(p))

  const { running, stale } = await classifySessionPods(
    pods, Date.now(), watcherDisplayLiveness, testEnv.startingGraceMs,
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
          forwardedPorts: [],
        }
      }
      const [prompt, blockedHosts] = await Promise.all([
        getSessionFirstMessage(p.projectSlug, p.sessionId, tool, p.jobName),
        readBlockedHosts(p.sessionId),
      ])
      return {
        sessionId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        status: readSessionStatus(p.projectSlug, p.sessionId),
        createdAt: formatCreated(p.createdAtMs),
        waitingSinceMs: readSessionWaitingSince(p.projectSlug, p.sessionId),
        prompt,
        title: titlesBySlug.get(p.projectSlug)?.[p.sessionId],
        blockedHosts,
        forwardedPorts: getSessionPorts(p.sessionId),
      }
    }),
  )

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
  const graceMs = testEnv.startingGraceMs
  const { running, stale, indeterminate } = await classifySessionPods(pods, nowMs, probeTmuxLiveness, graceMs)

  // Surface the near-miss: a running pod we deliberately did NOT reap
  // because its tmux probe was inconclusive (transient kubectl-exec
  // failure) — historically the main false-positive source. Without this
  // line the avoided reap is invisible, so a flapping probe looks like
  // nothing happened.
  for (const p of indeterminate) {
    daemonLog(
      `[daemon] stale-reaper: keeping session=${p.sessionId} job=${p.jobName}`
      + ' (tmux probe inconclusive; pod still running)',
    )
  }

  // Half-provisioned zombie sweep: a create killed between opening tmux
  // (the `sleep infinity` placeholder window) and respawning the agent —
  // e.g. a daemon restart mid-create — leaves a pod whose tmux is alive
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

  const targets = [
    ...stale.map((s) => ({ jobName: s.jobName, projectSlug: s.projectSlug, sessionId: s.sessionId })),
    ...placeholderStale.map((s) => ({ jobName: s.jobName, projectSlug: s.projectSlug, sessionId: s.sessionId })),
    ...orphanTargets,
  ]
  if (targets.length === 0) return

  // Audit each reap with its reason before the (detached, silent)
  // teardown runs, so a session disappearing is always explained.
  for (const s of stale) {
    const reason = s.zombie ? 'tmux gone, pod still running' : 'pod stopped'
    daemonLog(`[daemon] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (${reason})`)
  }
  for (const s of placeholderStale) {
    daemonLog(`[daemon] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (agent never started; placeholder pane past grace)`)
  }
  for (const o of orphanTargets) {
    daemonLog(`[daemon] stale-reaper: reaping session=${o.sessionId} job=${o.jobName} (orphan Job, no backing pod)`)
  }

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
   * birthtime alongside each entry so the sort is stable across files
   * created in the same second (createdAt is truncated to second
   * precision for display). These are daemon-written regular files
   * (never symlinks), so plain `fs.stat` is used.
   */
  async function collectDeleted(
    dir: string,
    ext: string,
    tool: DeletedSessionEntry['tool'],
    slug: string,
  ): Promise<Array<{ entry: DeletedSessionEntry; birthtimeMs: number }>> {
    const out: Array<{ entry: DeletedSessionEntry; birthtimeMs: number }> = []
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
            createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
          },
          birthtimeMs: stat.birthtimeMs,
        })
      } catch {
        continue
      }
    }
    return out
  }

  const collected: Array<{ entry: DeletedSessionEntry; birthtimeMs: number }> = []
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
    // reads from.
    collected.push(...await collectDeleted(opencodeMetaDir(slug), '.json', 'opencode', slug))
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
