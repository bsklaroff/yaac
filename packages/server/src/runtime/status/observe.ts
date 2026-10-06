import { workspaceDriver } from '#drivers/driver'
import { testEnv } from '@yaac/shared/env'
import { classifyWorkspaces, watcherDisplayLiveness } from './classify'
import {
  liveAgents,
  readAgentStatus,
  readWorkspaceStatus,
  readWorkspaceTerminals,
  readWorkspaceWaitingSince,
} from './status-store'
import { pruneTerminating } from './terminating'
import type { AgentLiveness, RuntimeHandle } from '#drivers/contract'
import type {
  AgentStatus,
  AgentTool,
  GitAuthFailure,
  PortMapping,
  StaleWorkspaceInfo,
  WorkspaceTerminalEntry,
} from '@yaac/shared/types'

/**
 * What the runtime says its workspaces are doing now. Always a whole
 * snapshot, never a delta: the observer is stateless, so the join never
 * reconciles a partial stream against a restart.
 */
export interface RuntimeReport {
  workspaces: WorkspaceRuntimeReport[]
  /** Recorded workspaces whose runtime is gone, for the caller to tear down. */
  stale: StaleWorkspaceInfo[]
  /** Project id → git credentials the upstream rejected. Project-wide: a
   *  bad token blocks new work even with nothing running. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface WorkspaceRuntimeReport {
  workspaceId: string
  projectId: string
  tool: AgentTool
  /** A `terminating` workspace is a non-interactive placeholder; its agents
   *  are already evicted, so it reports none. */
  phase: 'running' | 'terminating'
  /** When the runtime came up. The join prefers the recorded time (which
   *  survives restarts); this is the fallback when there is no row. */
  createdAtMs: number
  /** The workspace's aggregate over every live agent (`readWorkspaceStatus`). */
  status: AgentStatus
  waitingSinceMs?: number
  /** Per-agent liveness, keyed by the driver's handle (tmux pane id under
   *  `tui`, acpd window name under `acp`). The join attaches conversations by
   *  the handle each was last seen on. */
  agents: AgentLiveness[]
  /** Its non-agent tmux windows; absent until the watcher first lists them. */
  terminals?: WorkspaceTerminalEntry[]
  blockedHosts: string[]
  forwardedPorts: PortMapping[]
  unforwardedPorts: number[]
}

/**
 * The runtime half of a workspace listing, recomputed on every call: which
 * workspaces the driver holds, the status store, forwarders, the egress
 * path's blocked hosts and git-auth state. The durable half (titles, pins,
 * conversations) is the server's; `listActiveWorkspaces` joins them
 * (docs/layered-server.md).
 *
 * Driver-neutral: drivers supply only the raw facts. Runs on every
 * snapshot, so the listing uses `preferCache`.
 *
 * Agent liveness is keyed by handle, since which conversation is on a
 * handle is recorded by the server, not known here.
 */
export async function observeWorkspaces(projectFilter?: string): Promise<RuntimeReport> {
  const driver = workspaceDriver()
  // Hide unclaimed spares (and skip their status reads). The stale reaper
  // takes its own listing, so a stuck spare is still reaped.
  const handles = (await driver.list(projectFilter, { preferCache: true }))
    .filter((w) => !w.prewarmed)

  const { running, terminating, stale } = await classifyWorkspaces(
    handles, Date.now(), watcherDisplayLiveness, testEnv.startingGraceMs,
  )

  // Drop terminating marks for workspaces that are gone or past the TTL (a
  // failed teardown), so rows do not stay greyed forever.
  pruneTerminating(
    new Set(handles.map((w) => w.workspaceId).filter((v): v is string => !!v)),
    Date.now(),
  )

  const workspaces = [
    ...await Promise.all(running.map((w) => observeRunning(w))),
    // Status is forced to `running` (by `emptyReport`): the evicted status
    // store would default to `waiting` and show a spurious attention badge
    // on a disappearing row.
    ...terminating.map((w) => emptyReport(w, 'terminating')),
  ]

  return {
    workspaces,
    stale,
    gitAuthFailures: await driver.gitAuthFailures(),
  }
}

async function observeRunning(w: RuntimeHandle): Promise<WorkspaceRuntimeReport> {
  const base = emptyReport(w, 'running')
  if (!w.workspaceId || !w.projectId) return base
  const driver = workspaceDriver()
  const waitingSinceMs = readWorkspaceWaitingSince(w.projectId, w.workspaceId)
  const terminals = readWorkspaceTerminals(w.projectId, w.workspaceId)
  return {
    ...base,
    // Aggregate over the workspace's live agents (see status-store).
    status: readWorkspaceStatus(w.projectId, w.workspaceId),
    ...(waitingSinceMs !== undefined ? { waitingSinceMs } : {}),
    agents: agentLiveness(w.projectId, w.workspaceId),
    ...(terminals !== undefined ? { terminals } : {}),
    blockedHosts: await driver.blockedHosts(w.workspaceId),
    forwardedPorts: await driver.forwardedPorts(w.workspaceId),
    unforwardedPorts: await driver.unforwardedPorts(w.workspaceId),
  }
}

function emptyReport(w: RuntimeHandle, phase: 'running' | 'terminating'): WorkspaceRuntimeReport {
  return {
    workspaceId: w.workspaceId,
    projectId: w.projectId,
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
function agentLiveness(projectId: string, workspaceId: string): AgentLiveness[] {
  const observed = liveAgents(projectId, workspaceId)
  if (observed === undefined) return []
  const seen = new Set<string>()
  const out: AgentLiveness[] = []
  for (const { handle } of observed) {
    if (seen.has(handle)) continue
    seen.add(handle)
    const agent = readAgentStatus(projectId, workspaceId, handle)
    if (agent === undefined) continue
    out.push({
      handle,
      status: agent.status,
      ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
    })
  }
  return out
}
