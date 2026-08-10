import type {
  AgentTool,
  GitAuthFailure,
  PortMapping,
  StaleWorktreeInfo,
} from '@yaac/shared/types'

/**
 * The vocabulary of runtime observation — what the substrate can see right
 * now, and nothing that survives it (docs/plans/layered-server.md).
 *
 * The durable half of a listing (a title, a pin, the recorded creation
 * time, the sessions and their opening messages) lives in `#records`;
 * joining the two is how a worktree list is produced. Keeping the split in
 * the types is what keeps the join honest: nothing here can carry a fact a
 * restart of the substrate would lose track of.
 *
 * This module grows into the `WorktreeRuntime` driver contract when the
 * runtime layer is carved out (the k8s runtime as its first
 * implementation, a host-process runtime as its second).
 */

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
 * A worktree as the substrate can see it — everything a resolver needs and
 * nothing records keeps. The durable half (a title, a pin, the recorded
 * creation time, the conversations) never appears here.
 *
 * Distinct from `WorktreeRuntimeReport`, which is what a whole report
 * carries: this is the answer to "which worktree does this id name", so it
 * names the runtime handle an exec addresses and says nothing about
 * liveness.
 */
export interface RuntimeHandle {
  workspaceId: string
  projectSlug: string
  /** The runtime's own name for it, which is what an exec addresses. */
  jobName: string
  tool: AgentTool
  running: boolean
  /** Lowercased runtime phase — `running`, `pending`, `failed`, … */
  state: string
  labels: Record<string, string>
  createdAtMs: number
  /** A warmed spare, not a user's worktree. */
  prewarmed: boolean
}

export interface AgentLiveness {
  handle: string
  status: 'running' | 'waiting'
  waitingSinceMs?: number
}
