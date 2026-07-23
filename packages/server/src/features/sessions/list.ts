import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionPods, isPrewarmed, type SessionPod } from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import { isDeferredClusterBootPending, triggerDeferredClusterBoot } from '#platform/k8s/deferred-boot'
import { worktreeUpstreamBranch } from '#platform/git'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import {
  getSessionFirstMessage,
  normalizeTool,
  pruneTerminating,
  listBackgroundSessionIds,
} from '#features/sessions/state'
import { readSessionStatus, readSessionWaitingSince } from '#features/sessions/status-store'
import { getSessionPorts } from '#features/sessions/forwarders/port-forwarders'
import { readBlockedHosts } from '#features/sessions/egress/blocked-hosts'
import { readAllGitAuthFailures } from '#features/projects/git-auth-failures'
import { getSessionTitles } from '#features/titles/titles'
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
 * Session-branch upstream cache, keyed `<slug>/<sessionId>`. The upstream
 * (`branch.agent/<id>.merge`) is written during create (or a claim's
 * re-branch prep) before the session ever lists as a user session, and
 * nothing rewrites it while the session runs — but a spare mid-claim can
 * still be listed before its rewrite lands, so entries expire on a short
 * TTL rather than living forever. Without this, every 5s snapshot rebuild
 * spawned one `git config` subprocess per running session.
 */
const UPSTREAM_BRANCH_CACHE_TTL_MS = 60_000
const upstreamBranchCache = new Map<string, { value: string | null; atMs: number }>()

/** Test-only: drop cached upstream branches. */
export function _clearUpstreamBranchCacheForTests(): void {
  upstreamBranchCache.clear()
}

async function cachedUpstreamBranch(
  slug: string,
  sessionId: string,
  nowMs: number,
): Promise<string | null> {
  const key = `${slug}/${sessionId}`
  const hit = upstreamBranchCache.get(key)
  if (hit && nowMs - hit.atMs < UPSTREAM_BRANCH_CACHE_TTL_MS) return hit.value
  // Lazy sweep so entries for long-gone sessions can't accumulate
  // unboundedly in a long-lived server.
  if (upstreamBranchCache.size > 256) {
    for (const [k, v] of upstreamBranchCache) {
      if (nowMs - v.atMs >= UPSTREAM_BRANCH_CACHE_TTL_MS) upstreamBranchCache.delete(k)
    }
  }
  try {
    const value = await worktreeUpstreamBranch(repoDir(slug), `agent/${sessionId}`)
    upstreamBranchCache.set(key, { value, atMs: nowMs })
    return value
  } catch {
    // Transient read failure — keep any expired hit rather than caching
    // the failure; the next rebuild retries.
    return hit?.value ?? null
  }
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

  // User-assigned titles, one file read per project — for both live and
  // terminating rows (the latter keep their title on the way out).
  const titleSlugs = [...new Set(
    [...running, ...terminating].map((p) => p.projectSlug).filter((v): v is string => !!v),
  )]
  const titlesBySlug = new Map(await Promise.all(
    titleSlugs.map(async (slug) => [slug, await getSessionTitles(slug)] as const),
  ))
  // Background pins, batched the same way — terminating rows keep their pin
  // so they stay in the Background section on the way out.
  const backgroundBySlug = new Map(await Promise.all(
    titleSlugs.map(async (slug) => [slug, await listBackgroundSessionIds(slug)] as const),
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
        cachedUpstreamBranch(p.projectSlug, p.sessionId, Date.now()),
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
        background: backgroundBySlug.get(p.projectSlug)?.has(p.sessionId) || undefined,
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
        background: p.projectSlug
          ? backgroundBySlug.get(p.projectSlug)?.has(p.sessionId) || undefined
          : undefined,
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
