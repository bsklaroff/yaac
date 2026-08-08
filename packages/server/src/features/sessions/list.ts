import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type SessionPod,
  getActiveClusterCache,
  isDeferredClusterBootPending,
  isPrewarmed,
  listSessionPods,
  triggerDeferredClusterBoot,
} from '#platform/k8s'
import { projectDir } from '@yaac/shared/project-paths'
import { normalizeTool } from '#features/agents'
import { getProjectWorktreeRows, type WorktreeRow } from './worktree-store'
import {
  classifySessionPods,
  pruneTerminating,
  readAgentStatus,
  readSessionStatus,
  readSessionWaitingSince,
  watcherDisplayLiveness,
} from '#features/status'
import {
  getProjectAgentSessions,
  toAgentSessionEntry,
  type AgentSessionLinkRow,
} from './agent-session-store'
import { getSessionPorts, getUnforwardedPorts } from '#features/forwarders'
import { readBlockedHosts } from '#features/egress'
import { readAllGitAuthFailures } from '#features/projects'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { ActiveSessionsResult, WorktreeListEntry } from '@yaac/shared/types'

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
    rowSlugs.map(async (slug) => [slug, await getProjectWorktreeRows(slug)] as const),
  ))
  const rowFor = (p: SessionPod): WorktreeRow | undefined =>
    p.projectSlug && p.sessionId ? rowsBySlug.get(p.projectSlug)?.get(p.sessionId) : undefined

  // The conversations inside each worktree, one query per project — the same
  // shape as the rows above, so a snapshot never pays per row.
  const idsBySlug = new Map<string, string[]>()
  for (const p of [...running, ...terminating]) {
    if (!p.projectSlug || !p.sessionId) continue
    idsBySlug.set(p.projectSlug, [...(idsBySlug.get(p.projectSlug) ?? []), p.sessionId])
  }
  const agentsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) =>
      [slug, await getProjectAgentSessions(slug, idsBySlug.get(slug) ?? [])] as const),
  ))
  const agentsFor = (p: SessionPod): AgentSessionLinkRow[] =>
    (p.projectSlug && p.sessionId
      ? agentsBySlug.get(p.projectSlug)?.get(p.sessionId)
      : undefined) ?? []

  const worktrees: WorktreeListEntry[] = await Promise.all(
    running.map(async (p): Promise<WorktreeListEntry> => {
      const tool = normalizeTool(p.tool)
      if (!p.sessionId || !p.projectSlug) {
        return {
          worktreeId: p.sessionId,
          projectSlug: p.projectSlug,
          tool,
          status: 'running',
          createdAt: formatUtcTimestamp(p.createdAtMs),
          agentSessions: [],
          blockedHosts: [],
          forwardedPorts: [],
          unforwardedPorts: [],
        }
      }
      const row = rowFor(p)
      const blockedHosts = await readBlockedHosts(p.sessionId)
      return {
        worktreeId: p.sessionId,
        projectSlug: p.projectSlug,
        tool,
        // Aggregate over the worktree's live agents (see status-store).
        status: readSessionStatus(p.projectSlug, p.sessionId),
        // The recorded creation time, which — unlike the pod's — survives a
        // restart. A session with no row yet (created by an older yaac, no
        // transcript for the backfill to find) falls back to its pod.
        createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(p.createdAtMs)).getTime()),
        waitingSinceMs: readSessionWaitingSince(p.projectSlug, p.sessionId),
        // The founding ask is the first conversation's opening message —
        // the worktree has none of its own.
        prompt: agentsFor(p)[0]?.firstPrompt,
        title: row?.title,
        agentSessions: agentsFor(p).map((l) => toAgentSessionEntry(l, liveStatus(p.projectSlug, p.sessionId, l))),
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
  worktrees.push(...terminating.map((p): WorktreeListEntry => {
    const row = rowFor(p)
    return {
      worktreeId: p.sessionId,
      projectSlug: p.projectSlug,
      tool: normalizeTool(p.tool),
      status: 'running',
      stopping: true,
      createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(p.createdAtMs)).getTime()),
      prompt: agentsFor(p)[0]?.firstPrompt,
      title: row?.title,
      agentSessions: [],
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

  return { worktrees, stale, gitAuthFailures }
}

/**
 * A live conversation's own busy/idle, read by the handle it was last seen on
 * — a tmux pane id under `tui`, the acpd window name under `acp`. A
 * conversation with no live handle (the worktree's history) has none, which is
 * how a client tells "still open" from "was open".
 */
function liveStatus(
  projectSlug: string,
  worktreeId: string,
  l: AgentSessionLinkRow,
): { status: 'running' | 'waiting'; waitingSinceMs?: number } | undefined {
  if (!l.active || l.paneId === undefined) return undefined
  const agent = readAgentStatus(projectSlug, worktreeId, l.paneId)
  if (agent === undefined) return undefined
  return {
    status: agent.status,
    ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
  }
}
