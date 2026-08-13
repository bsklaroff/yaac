import { worktreeDriver } from '#drivers/driver'
import { testEnv } from '@yaac/shared/env'
import { classifyWorkspaces, watcherDisplayLiveness } from './classify'
import { liveAgents, readAgentStatus, readWorktreeStatus, readWorktreeWaitingSince } from './status-store'
import { pruneTerminating } from './terminating'
import type { AgentLiveness, RuntimeHandle } from '#drivers/contract'
import type {
  AgentTool,
  GitAuthFailure,
  PortMapping,
  StaleWorktreeInfo,
} from '@yaac/shared/types'

/**
 * What the runtime says its worktrees are doing right now.
 *
 * A whole snapshot, never a delta: the observer holds no state, so it can
 * always recompute one, and the join never has to reconcile a partial
 * stream against a restart.
 */
export interface RuntimeReport {
  worktrees: WorktreeRuntimeReport[]
  /** Recorded worktrees whose runtime is gone, for the caller to tear down. */
  stale: StaleWorktreeInfo[]
  /** Project slug → git credentials the upstream rejected. Project-wide and
   *  independent of the worktree set: a bad token persists with nothing
   *  running and blocks new work. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface WorktreeRuntimeReport {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /** `terminating` is on its way out — a non-interactive placeholder, not a
   *  live worktree. Its agents are already evicted, so it reports none. */
  phase: 'running' | 'terminating'
  /** When the runtime came up. The join prefers the recorded time, which
   *  survives a restart; this is the fallback for a worktree with no row. */
  createdAtMs: number
  /** The worktree's aggregate over every live agent: `waiting` if any is. */
  status: 'running' | 'waiting'
  waitingSinceMs?: number
  /** Per-agent liveness, keyed by the driver's handle — a tmux pane id under
   *  `tui`, the acpd window name under `acp`. The join puts sessions onto
   *  these by the handle each was last seen on; a handle with no
   *  conversation is one whose id has not landed yet. */
  agents: AgentLiveness[]
  blockedHosts: string[]
  forwardedPorts: PortMapping[]
  unforwardedPorts: number[]
}

/**
 * The runtime half of a worktree listing: what can be seen right now.
 *
 * Everything here is recomputed on every call and none of it survives a
 * restart — which workspaces the driver holds, the watcher-fed status
 * store, the forwarder registry, the egress path's blocked hosts and
 * git-auth state. The durable half — titles, pins, recorded creation times,
 * conversations and their opening messages — is the server's, and
 * `listActiveWorktrees` is the join (docs/layered-server.md).
 *
 * Driver-neutral, and that is the point of it living here: the classify /
 * prune / liveness-join it performs is the same work over any substrate,
 * and a driver answers only for the raw facts it alone can see. It runs on
 * every snapshot, so the listing is taken `preferCache` — a driver whose
 * watch already streams the answer should not be made to go ask.
 *
 * Agent liveness is reported keyed by the driver's HANDLE rather than by
 * conversation, because which conversation sits on a handle is a fact the
 * server records and this half never learns. The join is what puts the two
 * back together.
 */
export async function observeWorkspaces(projectFilter?: string): Promise<RuntimeReport> {
  const driver = worktreeDriver()
  // Prewarmed spares are not user worktrees until claimed — hide them from
  // the listing (and skip the status/first-message reads they would
  // trigger). The stale reaper deliberately still sees them (it takes its
  // own listing), so a stuck spare is still reaped.
  const workspaces = (await driver.list(projectFilter, { preferCache: true }))
    .filter((w) => !w.prewarmed)

  const { running, terminating, stale } = await classifyWorkspaces(
    workspaces, Date.now(), watcherDisplayLiveness, testEnv.startingGraceMs,
  )

  // Forget terminating marks whose workspace is gone (teardown finished) or
  // that outlived the TTL (a failed teardown), so the set can't leak or
  // strand a permanently-greyed row.
  pruneTerminating(
    new Set(workspaces.map((w) => w.workspaceId).filter((v): v is string => !!v)),
    Date.now(),
  )

  const worktrees = await Promise.all([
    ...running.map((w) => observeRunning(w)),
    ...terminating.map((w) => observeTerminating(w)),
  ])

  return {
    worktrees,
    stale,
    gitAuthFailures: await driver.allGitAuthFailures(),
  }
}

async function observeRunning(w: RuntimeHandle): Promise<WorktreeRuntimeReport> {
  const base = emptyReport(w, 'running')
  if (!w.workspaceId || !w.projectSlug) return base
  const driver = worktreeDriver()
  const waitingSinceMs = readWorktreeWaitingSince(w.projectSlug, w.workspaceId)
  return {
    ...base,
    // Aggregate over the workspace's live agents (see status-store).
    status: readWorktreeStatus(w.projectSlug, w.workspaceId),
    ...(waitingSinceMs !== undefined ? { waitingSinceMs } : {}),
    agents: agentLiveness(w.projectSlug, w.workspaceId),
    blockedHosts: await driver.blockedHosts(w.workspaceId),
    forwardedPorts: await driver.forwardedPorts(w.workspaceId),
    unforwardedPorts: await driver.unforwardedPorts(w.workspaceId),
  }
}

/**
 * A workspace on its way out. Status is forced to `running` rather than read
 * from the status store, which was evicted at teardown and would default to
 * `waiting` — a spurious attention badge on a row that is disappearing — and
 * no waiting stamp is reported for the same reason.
 */
function observeTerminating(w: RuntimeHandle): Promise<WorktreeRuntimeReport> {
  return Promise.resolve(emptyReport(w, 'terminating'))
}

function emptyReport(w: RuntimeHandle, phase: 'running' | 'terminating'): WorktreeRuntimeReport {
  return {
    workspaceId: w.workspaceId,
    projectSlug: w.projectSlug,
    tool: w.tool,
    phase,
    createdAtMs: w.createdAtMs,
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
