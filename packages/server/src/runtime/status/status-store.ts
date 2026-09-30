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
 * - The aggregate is `waiting` if any agent waits: an agent that needs you
 *   needs you regardless of its siblings.
 * - Status is sticky across watcher respawns: a dropped stream flips
 *   `streamHealthy` but keeps the last status, so blips do not flap the UI.
 * - `streamHealthy` is the display path's tmux-liveness signal (both
 *   drivers reach the agent through tmux). It is never a death signal; only
 *   the reaper's probes decide `dead`, and losing health is when they run
 *   (`onStreamHealthLost`).
 */

import { notifyWorkspaceListChanged } from '#notify'
import type { LiveAgent, AgentPaneStatus } from '#runtime/agents'

export type { AgentPaneStatus }

export interface AgentStatusEntry {
  status: AgentPaneStatus
  /** Epoch ms when the current waiting spell began; set only while
   *  waiting. */
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

let liveAgentsListener: (() => void) | null = null
let streamHealthLostListener: (() => void) | null = null

function key(slug: string, workspaceId: string): string {
  return `${slug}/${workspaceId}`
}

/**
 * Announce a change to this store's snapshot inputs (aggregate status,
 * waiting spell, stream health) on `#notify` (docs/layered-server.md).
 */
function notifyChanged(): void {
  notifyWorkspaceListChanged()
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

/**
 * The workspace's status: `waiting` if any of its agents is waiting, else
 * `running` if any is running, else `waiting` (nothing classified yet).
 */
export function readWorkspaceStatus(slug: string, workspaceId: string): AgentPaneStatus {
  const agents = store.get(key(slug, workspaceId))?.agents
  if (!agents || agents.size === 0) return 'waiting'
  for (const a of agents.values()) if (a.status === 'waiting') return 'waiting'
  return 'running'
}

/**
 * Start of the workspace's current waiting spell (epoch ms), or undefined
 * while nothing waits. The earliest waiting conversation wins, so a second
 * agent going idle does not reset a client's per-spell read mark.
 */
export function readWorkspaceWaitingSince(slug: string, workspaceId: string): number | undefined {
  const e = store.get(key(slug, workspaceId))
  if (!e) return undefined
  let earliest: number | undefined
  for (const a of e.agents.values()) {
    if (a.status !== 'waiting' || a.waitingSinceMs === undefined) continue
    if (earliest === undefined || a.waitingSinceMs < earliest) earliest = a.waitingSinceMs
  }
  // Nothing classified yet: the spell started when the connection attached.
  return earliest ?? (e.agents.size === 0 ? e.attachedWaitingSinceMs : undefined)
}

/** One conversation's status, for the per-agent dot on its tab. */
export function readAgentStatus(
  slug: string,
  workspaceId: string,
  handle: string,
): AgentStatusEntry | undefined {
  return store.get(key(slug, workspaceId))?.agents.get(handle)
}

/**
 * Every conversation the watcher sees running, or undefined before the
 * first enumeration. The agent-session registry marks those naming a
 * conversation active, and skips the update on undefined.
 */
export function liveAgents(slug: string, workspaceId: string): LiveAgent[] | undefined {
  return store.get(key(slug, workspaceId))?.liveAgents
}

/**
 * Whether the workspace's watcher connection is healthy, i.e. a driver is
 * attached to its tmux right now. No entry → false (unknown, not dead).
 */
export function isWorkspaceStreamHealthy(slug: string, workspaceId: string): boolean {
  return store.get(key(slug, workspaceId))?.streamHealthy ?? false
}

/**
 * Record a classified status for one conversation. Creates the entry
 * (healthy, since classifications come only from live connections) and
 * notifies when anything clients see changed. That includes per-
 * conversation status and spells (shown as per-tab dots via
 * `agentLiveness`), not just the aggregate. A true no-op does not notify.
 */
export function setAgentStatus(
  slug: string,
  workspaceId: string,
  handle: string,
  status: AgentPaneStatus,
): void {
  const k = key(slug, workspaceId)
  const before = readWorkspaceStatus(slug, workspaceId)
  const hadEntry = store.has(k)
  const wasHealthy = store.get(k)?.streamHealthy ?? false
  const e = entry(k)
  const prev = e.agents.get(handle)
  // A spell keeps its stamp while waiting continues, restarts on entering
  // waiting, and clears on running.
  const waitingSinceMs = status === 'waiting'
    ? (prev?.status === 'waiting' && prev.waitingSinceMs !== undefined
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
    || readWorkspaceStatus(slug, workspaceId) !== before) {
    notifyChanged()
  }
}

/**
 * Publish the conversations running now. Vanished ones lose their status,
 * or a dead agent's `waiting` would stay in the aggregate forever.
 */
export function setLiveAgents(slug: string, workspaceId: string, agents: LiveAgent[]): void {
  const k = key(slug, workspaceId)
  const before = readWorkspaceStatus(slug, workspaceId)
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
  if (changed || readWorkspaceStatus(slug, workspaceId) !== before) notifyChanged()
}

/**
 * Set stream health, keeping the sticky status. Marking an absent workspace
 * healthy creates an entry (the attach proves tmux is up); marking it
 * unhealthy does nothing.
 */
export function setWorkspaceStreamHealth(slug: string, workspaceId: string, healthy: boolean): void {
  const k = key(slug, workspaceId)
  const prev = store.get(k)
  if (!prev) {
    if (!healthy) return
    const e = entry(k)
    e.streamHealthy = true
    e.attachedWaitingSinceMs = Date.now()
    notifyChanged()
    return
  }
  if (prev.streamHealthy === healthy) return
  prev.streamHealthy = healthy
  prev.updatedAtMs = Date.now()
  notifyChanged()
  // healthy → unhealthy: tmux liveness can no longer be inferred, so the
  // reaper needs a pass.
  if (!healthy) streamHealthLostListener?.()
}

/**
 * Drop a workspace's entry, on teardown (`#domain/workspaces` cleanup) and
 * when the watcher manager retires a workspace, so a reused id never sees
 * the previous status.
 */
export function evictWorkspaceStatus(slug: string, workspaceId: string): void {
  if (store.delete(key(slug, workspaceId))) notifyChanged()
}

/** Test-only: drop every entry and the change listener. */
export function _resetWorkspaceStatusStoreForTests(): void {
  store.clear()
  liveAgentsListener = null
  streamHealthLostListener = null
}
