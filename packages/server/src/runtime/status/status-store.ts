/**
 * In-memory store of agent status, fed by the status watchers
 * (`status-watcher.ts`) and read by every display path.
 *
 * Status is per conversation: a workspace can hold several, each with its
 * own busy/idle, and the workspace's status is an aggregate. Conversations
 * are keyed by the driver's handle (tmux pane id `%3` for `tui`, acpd window
 * name `claude-2` for `acp`), so the store is mode-agnostic; the registry
 * maps handles back to conversations.
 *
 * Drivers push changes as they observe them, so reads are synchronous
 * lookups and never trigger an exec.
 *
 * Semantics:
 * - No entry → `waiting` (booting, or not yet reachable).
 * - The aggregate is the most pressing agent's status: `asking`, then
 *   `waiting` (an agent that needs you needs you regardless of its
 *   siblings), then `running`, then `background`.
 * - A waiting spell covers both statuses that need the user (`needsUser`),
 *   since listings send an ask as `waiting` (`ListedAgentStatus`).
 * - Status is sticky across watcher respawns: a dropped stream flips
 *   `streamHealthy` but keeps the last status, so blips do not flap the UI.
 * - `streamHealthy` is the display path's tmux-liveness signal (both
 *   drivers reach the agent through tmux). It is never a death signal; only
 *   the reaper's probes decide `dead`, and losing health is when they run
 *   (`onStreamHealthLost`).
 */

import { notifyWorkspaceListChanged } from '#notify'
import type { LiveAgent } from '#runtime/agents'
import type { AgentStatus, WorkspaceTerminalEntry } from '@yaac/shared/types'

export interface AgentStatusEntry {
  status: AgentStatus
  /** Epoch ms when the current waiting spell began; set only while it
   *  needs the user. */
  waitingSinceMs?: number
  updatedAtMs: number
}

export interface WorkspaceStatusEntry {
  /** True while the workspace's watcher connection is up and classifying. */
  streamHealthy: boolean
  /** Epoch ms of the last write (status or health). */
  updatedAtMs: number
  /** Per-conversation status, keyed by the driver's handle. */
  agents: Map<string, AgentStatusEntry>
  /**
   * Every conversation the watcher last saw running, or undefined before the
   * first enumeration. Undefined means unknown, not "no agents", which would
   * make a stream gap look like every agent exiting.
   */
  liveAgents?: LiveAgent[]
  /**
   * Waiting-spell start for a workspace whose connection is up but whose
   * agent is not classified yet (still booting), so clients keying unread
   * marks on the spell have something to key on.
   */
  attachedWaitingSinceMs?: number
}

const store = new Map<string, WorkspaceStatusEntry>()
/** Each workspace's non-agent tmux windows, as its watcher last listed them.
 *  Kept apart from `store`, whose entry creation marks an attach. */
const terminals = new Map<string, WorkspaceTerminalEntry[]>()

let liveAgentsListener: (() => void) | null = null
let streamHealthLostListener: (() => void) | null = null

function key(projectId: string, workspaceId: string): string {
  return `${projectId}/${workspaceId}`
}

/**
 * Register the handler fired when a driver connection goes from healthy to
 * unhealthy. `probeTmuxLiveness` infers "stream healthy ⇒ tmux alive", so
 * after this transition the reaper's real probes are needed. Fires only on
 * that transition, since it triggers a reconcile pass (a pass per turn
 * would be too costly). It decides when to probe, not whether a workspace
 * is dead. Single listener.
 */
export function onStreamHealthLost(fn: () => void): void {
  streamHealthLostListener = fn
}

/**
 * Register the handler fired when a workspace's set of live conversations
 * changes: one appears or goes, learns its id, or switches model or
 * permission mode (how `/model` and Shift+Tab reach the row). Separate from
 * the snapshot notification, which fires every turn, because this triggers
 * a reconcile pass. Matters most for `acp`, whose id arrives from the
 * handshake with no substrate event; without it the row and chat pane would
 * wait for the 60s resync. Single listener.
 */
export function onLiveAgentsChanged(fn: () => void): void {
  liveAgentsListener = fn
}

function entry(k: string): WorkspaceStatusEntry {
  const existing = store.get(k)
  if (existing) return existing
  const fresh: WorkspaceStatusEntry = {
    streamHealthy: false,
    updatedAtMs: Date.now(),
    agents: new Map(),
  }
  store.set(k, fresh)
  return fresh
}

/** Whether a status needs the user: a finished turn or an open ask. */
function needsUser(status: AgentStatus | undefined): boolean {
  return status === 'waiting' || status === 'asking'
}

/** Statuses from most to least pressing; the aggregate takes the first. */
const STATUS_PRECEDENCE: readonly AgentStatus[] = ['asking', 'waiting', 'running', 'background']

/**
 * The workspace's status: its most pressing agent's (`STATUS_PRECEDENCE`),
 * or `waiting` when nothing is classified yet.
 */
export function readWorkspaceStatus(projectId: string, workspaceId: string): AgentStatus {
  const statuses = new Set([...store.get(key(projectId, workspaceId))?.agents.values() ?? []].map((a) => a.status))
  return STATUS_PRECEDENCE.find((s) => statuses.has(s)) ?? 'waiting'
}

/**
 * Start of the workspace's current waiting spell (epoch ms), or undefined
 * while nothing needs the user. The earliest such conversation wins, so a
 * second agent going idle or asking does not reset a client's per-spell
 * read mark, and answering it does not bring back a spell already seen.
 */
export function readWorkspaceWaitingSince(projectId: string, workspaceId: string): number | undefined {
  const e = store.get(key(projectId, workspaceId))
  if (!e) return undefined
  let earliest: number | undefined
  for (const a of e.agents.values()) {
    if (!needsUser(a.status) || a.waitingSinceMs === undefined) continue
    if (earliest === undefined || a.waitingSinceMs < earliest) earliest = a.waitingSinceMs
  }
  // Nothing classified yet: the spell started when the connection attached.
  return earliest ?? (e.agents.size === 0 ? e.attachedWaitingSinceMs : undefined)
}

/** One conversation's status, for the per-agent dot on its tab. */
export function readAgentStatus(
  projectId: string,
  workspaceId: string,
  handle: string,
): AgentStatusEntry | undefined {
  return store.get(key(projectId, workspaceId))?.agents.get(handle)
}

/**
 * Every conversation the watcher sees running, or undefined before the
 * first enumeration. The agent-session registry marks those naming a
 * conversation active, and skips the update on undefined.
 */
export function liveAgents(projectId: string, workspaceId: string): LiveAgent[] | undefined {
  return store.get(key(projectId, workspaceId))?.liveAgents
}

/**
 * Whether the workspace's watcher connection is healthy, i.e. a driver is
 * attached to its tmux right now. No entry → false (unknown, not dead).
 */
export function isWorkspaceStreamHealthy(projectId: string, workspaceId: string): boolean {
  return store.get(key(projectId, workspaceId))?.streamHealthy ?? false
}

/**
 * Record a classified status for one conversation. Creates the entry
 * (healthy, since classifications come only from live connections) and
 * notifies when anything clients see changed. That includes per-
 * conversation status and spells (shown as per-tab dots via
 * `agentLiveness`), not just the aggregate. A true no-op does not notify.
 */
export function setAgentStatus(
  projectId: string,
  workspaceId: string,
  handle: string,
  status: AgentStatus,
): void {
  const k = key(projectId, workspaceId)
  const before = readWorkspaceStatus(projectId, workspaceId)
  const hadEntry = store.has(k)
  const wasHealthy = store.get(k)?.streamHealthy ?? false
  const e = entry(k)
  const prev = e.agents.get(handle)
  // A spell keeps its stamp while the agent needs the user, restarts on
  // entering that, and clears on leaving it.
  const waitingSinceMs = needsUser(status)
    ? (needsUser(prev?.status) && prev?.waitingSinceMs !== undefined
      ? prev.waitingSinceMs
      : Date.now())
    : undefined
  e.agents.set(handle, {
    status,
    updatedAtMs: Date.now(),
    ...(waitingSinceMs !== undefined ? { waitingSinceMs } : {}),
  })
  // A real classification supersedes the boot-time spell.
  delete e.attachedWaitingSinceMs
  e.streamHealthy = true
  e.updatedAtMs = Date.now()
  // Also notify when health returns, which clients render even if the
  // status held.
  const entryChanged = !prev
    || prev.status !== status
    || prev.waitingSinceMs !== waitingSinceMs
  if (entryChanged || !hadEntry || !wasHealthy
    || readWorkspaceStatus(projectId, workspaceId) !== before) {
    notifyWorkspaceListChanged()
  }
}

/**
 * Publish the conversations running now. Vanished ones lose their status,
 * or a dead agent's `waiting` would stay in the aggregate forever.
 */
export function setLiveAgents(projectId: string, workspaceId: string, agents: LiveAgent[]): void {
  const k = key(projectId, workspaceId)
  const before = readWorkspaceStatus(projectId, workspaceId)
  const e = entry(k)
  const next = new Set(agents.map((a) => a.handle))
  const previous = e.liveAgents
  const changed = previous === undefined
    || previous.length !== agents.length
    || agents.some((a) => !previous.some((p) =>
      p.handle === a.handle && p.agentSessionId === a.agentSessionId && p.model === a.model
      && p.reportedMode === a.reportedMode && p.transcriptPath === a.transcriptPath))
  e.liveAgents = agents
  for (const handle of [...e.agents.keys()]) if (!next.has(handle)) e.agents.delete(handle)
  e.updatedAtMs = Date.now()
  // Membership, id, model or mode changes trigger a reconcile pass (the
  // registry joins against them), so a new ACP conversation becomes a row
  // without waiting for the resync.
  if (changed) liveAgentsListener?.()
  if (changed || readWorkspaceStatus(projectId, workspaceId) !== before) notifyWorkspaceListChanged()
}

/**
 * Set stream health, keeping the sticky status. Marking an absent workspace
 * healthy creates an entry (the attach proves tmux is up); marking it
 * unhealthy does nothing.
 */
export function setWorkspaceStreamHealth(projectId: string, workspaceId: string, healthy: boolean): void {
  const k = key(projectId, workspaceId)
  const prev = store.get(k)
  if (!prev) {
    if (!healthy) return
    const e = entry(k)
    e.streamHealthy = true
    e.attachedWaitingSinceMs = Date.now()
    notifyWorkspaceListChanged()
    return
  }
  if (prev.streamHealthy === healthy) return
  prev.streamHealthy = healthy
  prev.updatedAtMs = Date.now()
  notifyWorkspaceListChanged()
  // healthy → unhealthy: tmux liveness can no longer be inferred, so the
  // reaper needs a pass.
  if (!healthy) streamHealthLostListener?.()
}

/** Record the workspace's terminals, notifying only on a change. */
export function setWorkspaceTerminals(
  projectId: string,
  workspaceId: string,
  entries: WorkspaceTerminalEntry[],
): void {
  const k = key(projectId, workspaceId)
  if (JSON.stringify(terminals.get(k)) === JSON.stringify(entries)) return
  terminals.set(k, entries)
  notifyWorkspaceListChanged()
}

/** The workspace's terminals, or undefined before its watcher first listed
 *  them (unknown, not none). */
export function readWorkspaceTerminals(projectId: string, workspaceId: string): WorkspaceTerminalEntry[] | undefined {
  return terminals.get(key(projectId, workspaceId))
}

/**
 * Drop a workspace's entry and terminals, on teardown (`#domain/workspaces` cleanup) and
 * when the watcher manager retires a workspace, so a reused id never sees
 * the previous status.
 */
export function evictWorkspaceStatus(projectId: string, workspaceId: string): void {
  const k = key(projectId, workspaceId)
  const hadTerminals = terminals.delete(k)
  if (store.delete(k) || hadTerminals) notifyWorkspaceListChanged()
}

/** Test-only: drop every entry and the change listener. */
export function _resetWorkspaceStatusStoreForTests(): void {
  store.clear()
  terminals.clear()
  liveAgentsListener = null
  streamHealthLostListener = null
}
