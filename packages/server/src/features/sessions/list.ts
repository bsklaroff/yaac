import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionPods, isPrewarmed, type SessionPod } from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import { isDeferredClusterBootPending, triggerDeferredClusterBoot } from '#platform/k8s/deferred-boot'
import { projectDir } from '@yaac/shared/project-paths'
import { normalizeTool, pruneTerminating } from '#features/sessions/state'
import { getProjectSessionRows, type SessionRow } from '#features/sessions/store'
import { readSessionStatus, readSessionWaitingSince } from '#features/sessions/status-store'
import { getSessionPorts } from '#features/sessions/forwarders/port-forwarders'
import { getUnforwardedPorts } from '#features/sessions/forwarders/port-detector'
import { readBlockedHosts } from '#features/sessions/egress/blocked-hosts'
import { readAllGitAuthFailures } from '#features/projects/git-auth-failures'
import { classifySessionPods, watcherDisplayLiveness } from '#features/sessions/classify'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { ActiveSessionsResult, SessionListEntry } from '@yaac/shared/types'

export async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  }
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

  // In the server the informer's push-fed cache answers instantly; the
  // one-shot kubectl list is the fallback for cache-less contexts (unit
  // tests, a cache that hasn't started yet).
  const cache = getActiveClusterCache()
  let pods: SessionPod[]
  if (cache) {
    pods = cache.sessionPods(projectFilter)
  } else if (isDeferredClusterBootPending()) {
    // A nested server whose deferred cluster attach hasn't finished has
    // no session pods by construction (session create awaits the
    // attach), so answer empty instantly instead of holding the caller
    // — and the web-app's first snapshot, projects included — on a
    // kubectl call to a still-waking vcluster. Still kick the attach:
    // connecting the web app is a real use, and once it completes the
    // caches push a fresh snapshot.
    triggerDeferredClusterBoot()
    pods = []
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

  // Recorded session state — prompt, title, base branch, pin — one query per
  // project for both live and terminating rows (the latter keep their title
  // and pin on the way out).
  const rowSlugs = [...new Set(
    [...running, ...terminating].map((p) => p.projectSlug).filter((v): v is string => !!v),
  )]
  const rowsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) => [slug, await getProjectSessionRows(slug)] as const),
  ))
  const rowFor = (p: SessionPod): SessionRow | undefined =>
    p.projectSlug && p.sessionId ? rowsBySlug.get(p.projectSlug)?.get(p.sessionId) : undefined

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
          unforwardedPorts: [],
        }
      }
      const row = rowFor(p)
      const blockedHosts = await readBlockedHosts(p.sessionId)
      return {
        sessionId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        status: readSessionStatus(p.projectSlug, p.sessionId),
        // The recorded creation time, which — unlike the pod's — survives a
        // restart. A session with no row yet (created by an older yaac, no
        // transcript for the backfill to find) falls back to its pod.
        createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(p.createdAtMs)).getTime()),
        waitingSinceMs: readSessionWaitingSince(p.projectSlug, p.sessionId),
        prompt: row?.prompt,
        title: row?.title,
        blockedHosts,
        forwardedPorts: getSessionPorts(p.sessionId),
        unforwardedPorts: getUnforwardedPorts(p.sessionId),
        baseBranch: row?.baseBranch,
        background: row?.background || undefined,
      }
    }),
  )

  // Terminating rows: a distinct, non-interactive placeholder. Status is
  // forced to 'running' (never read from the status store, which was evicted
  // at teardown and would default to 'waiting' — the flash we're killing) and
  // waitingSinceMs is omitted, so no attention badge fires.
  sessions.push(...terminating.map((p): SessionListEntry => {
    const row = rowFor(p)
    return {
      sessionId: p.sessionId,
      projectSlug: p.projectSlug,
      tool: normalizeTool(p.tool),
      status: 'running',
      terminating: true,
      createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(p.createdAtMs)).getTime()),
      prompt: row?.prompt,
      title: row?.title,
      blockedHosts: [],
      forwardedPorts: [],
      unforwardedPorts: [],
      background: row?.background || undefined,
    }
  }))

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
