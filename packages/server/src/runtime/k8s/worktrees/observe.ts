import {
  type PodInfo,
  getActiveClusterCache,
  isDeferredClusterBootPending,
  isPrewarmed,
  listWorktreePods,
  triggerDeferredClusterBoot,
} from '#runtime/k8s/substrate'
import { runtimeHandleFromPod } from '#runtime/k8s/view'
import {
  classifyWorkspaces,
  liveAgents,
  pruneTerminating,
  readAgentStatus,
  readWorktreeStatus,
  readWorktreeWaitingSince,
  watcherDisplayLiveness,
} from '#runtime/status'
import { getWorktreePorts, getUnforwardedPorts } from '#runtime/k8s/forwarders'
import { readAllGitAuthFailures, readBlockedHosts } from '#runtime/k8s/egress'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type {
  AgentLiveness,
  RuntimeHandle,
  RuntimeReport,
  WorktreeRuntimeReport,
} from '#runtime/contract'

/**
 * The runtime's half of a worktree listing: what the substrate can see right now.
 *
 * Everything here is recomputed from the runtime on every call and none of it
 * survives a restart — pods, the watcher-fed status store, the forwarder
 * registry, the egress proxy's blocked hosts, the projects' git-auth state.
 * The durable half — titles, pins, recorded creation times, conversations and
 * their opening messages — is the server's, and `listActiveWorktrees` is the
 * join (docs/layered-server.md).
 *
 * Agent liveness is reported keyed by the driver's HANDLE rather than by
 * conversation, because which conversation sits on a handle is a fact the
 * server records and this half never learns. The join is what puts the two
 * back together.
 */
export async function observeWorkspaces(projectFilter?: string): Promise<RuntimeReport> {
  // In the server the informer's push-fed cache answers instantly; the
  // one-shot kubectl list is the fallback for cache-less contexts (unit
  // tests, a cache that hasn't started yet).
  const cache = getActiveClusterCache()
  let pods: PodInfo[]
  if (cache) {
    pods = cache.worktreePods(projectFilter)
  } else if (isDeferredClusterBootPending()) {
    // A nested server whose deferred cluster attach hasn't finished has
    // no worktree pods by construction (worktree create awaits the
    // attach), so answer empty instantly instead of holding the caller
    // — and the web-app's first snapshot, projects included — on a
    // kubectl call to a still-waking vcluster. Still kick the attach:
    // connecting the web app is a real use, and once it completes the
    // caches push a fresh snapshot.
    triggerDeferredClusterBoot()
    pods = []
  } else {
    try {
      pods = await listWorktreePods(projectFilter)
    } catch (err) {
      throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
    }
  }

  // Prewarmed spares are not user worktrees until claimed — hide them from the
  // worktree list (and skip the status/first-message reads they'd trigger).
  // The stale reaper deliberately still sees them (it lists pods itself), so a
  // stuck spare is still reaped.
  const workspaces = pods.filter((p) => !isPrewarmed(p)).map(runtimeHandleFromPod)

  const { running, stale, terminating } = await classifyWorkspaces(
    workspaces, Date.now(), watcherDisplayLiveness, testEnv.startingGraceMs,
  )

  // Forget terminating marks whose pod is gone (teardown finished) or that
  // outlived the TTL (a failed teardown), so the set can't leak or strand a
  // permanently-greyed row.
  pruneTerminating(
    new Set(workspaces.map((w) => w.workspaceId).filter((v): v is string => !!v)),
    Date.now(),
  )

  const worktrees = await Promise.all([
    ...running.map((p) => observeRunning(p)),
    ...terminating.map((p) => observeTerminating(p)),
  ])

  return {
    worktrees,
    stale,
    gitAuthFailures: await readAllGitAuthFailures(),
  }
}

async function observeRunning(p: RuntimeHandle): Promise<WorktreeRuntimeReport> {
  const base = emptyReport(p, 'running')
  if (!p.workspaceId || !p.projectSlug) return base
  return {
    ...base,
    // Aggregate over the workspace's live agents (see status-store).
    status: readWorktreeStatus(p.projectSlug, p.workspaceId),
    ...(readWorktreeWaitingSince(p.projectSlug, p.workspaceId) !== undefined
      ? { waitingSinceMs: readWorktreeWaitingSince(p.projectSlug, p.workspaceId) }
      : {}),
    agents: agentLiveness(p.projectSlug, p.workspaceId),
    blockedHosts: await readBlockedHosts(p.workspaceId),
    forwardedPorts: getWorktreePorts(p.workspaceId),
    unforwardedPorts: getUnforwardedPorts(p.workspaceId),
  }
}

/**
 * A workspace on its way out. Status is forced to `running` rather than read
 * from the status store, which was evicted at teardown and would default to
 * `waiting` — a spurious attention badge on a row that is disappearing — and
 * no waiting stamp is reported for the same reason.
 */
function observeTerminating(p: RuntimeHandle): Promise<WorktreeRuntimeReport> {
  return Promise.resolve(emptyReport(p, 'terminating'))
}

function emptyReport(p: RuntimeHandle, phase: 'running' | 'terminating'): WorktreeRuntimeReport {
  return {
    workspaceId: p.workspaceId,
    projectSlug: p.projectSlug,
    tool: p.tool,
    phase,
    createdAtMs: p.createdAtMs,
    status: 'running',
    agents: [],
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
  }
}

/** Each live agent's own busy/idle, by the handle it is running on. */
function agentLiveness(projectSlug: string, worktreeId: string): AgentLiveness[] {
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return []
  const seen = new Set<string>()
  const out: AgentLiveness[] = []
  for (const { handle } of observed) {
    if (seen.has(handle)) continue
    seen.add(handle)
    const agent = readAgentStatus(projectSlug, worktreeId, handle)
    if (agent === undefined) continue
    out.push({
      handle,
      status: agent.status,
      ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
    })
  }
  return out
}
