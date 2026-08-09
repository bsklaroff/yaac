/**
 * Server-resident store of agent status, fed by the status watchers
 * (`status-watcher.ts`) and read by every display path (`/worktree/list`,
 * snapshots, the stream picker).
 *
 * Status is per *conversation*, not per worktree: a worktree can hold several
 * agent sessions at once (a second terminal, or a `/clear` that left the old
 * conversation's window open), and each has its own busy/idle. The worktree's
 * own status — what the sidebar row shows — is an aggregate over them.
 *
 * A conversation is keyed by its driver's **handle**: the address the driver
 * uses for it inside the pod. For `tui` that is a tmux pane id (`%3`); for
 * `acp` it is the acpd socket's window name (`claude-2`). Keying on the handle
 * rather than on anything tmux-shaped is what makes this store mode-agnostic —
 * it never learns which protocol produced a status, only that some
 * conversation at some address is running or waiting. Joining a handle back to
 * the conversation it belongs to is the registry's job, not this store's.
 *
 * Status is pushed in the moment a driver observes a change — a pane's OSC
 * title (claude/codex), its rendered content (opencode/pi), or an ACP prompt
 * turn starting and ending — so reads are synchronous map lookups and never
 * trigger a `kubectl exec`.
 *
 * Semantics:
 * - No entry for a conversation → `waiting`. Matches the probe-era answer for
 *   a worktree that hasn't set a title yet (booting) or whose pod isn't
 *   exec-able yet.
 * - The worktree aggregate is `waiting` if ANY of its agents is waiting.
 *   Waiting is the actionable state — an agent that needs you needs you
 *   whether or not a sibling is still working.
 * - Status is sticky across watcher respawns: a dropped stream flips
 *   `streamHealthy` but keeps the last classified status, so a transient
 *   transport hiccup never flaps the UI.
 * - `streamHealthy` doubles as the display-path tmux-liveness signal: a
 *   healthy driver connection is conclusive proof the in-pod tmux server is
 *   up (both drivers reach it through tmux). It is deliberately NOT a death
 *   signal — only the stale reaper's own probes may conclude `dead`.
 */

import type { LiveAgent, AgentPaneStatus } from '#features/agents'

export type { AgentPaneStatus }

export interface AgentStatusEntry {
  status: AgentPaneStatus
  /** Epoch ms when this conversation's current waiting spell began; set iff
   *  waiting. */
  waitingSinceMs?: number
  updatedAtMs: number
}

export interface WorktreeStatusEntry {
  /** True while the worktree's watcher connection is up and classifying. */
  streamHealthy: boolean
  /** Epoch ms of the last write (status or health). */
  updatedAtMs: number
  /** Per-conversation status, keyed by the driver's handle. */
  agents: Map<string, AgentStatusEntry>
  /**
   * Every conversation the watcher last saw running, or undefined before it
   * has ever enumerated them. The distinction matters: undefined means "not
   * known yet" and callers must not read it as "no agents are running", which
   * would make a stream gap look like every agent exiting.
   */
  liveAgents?: LiveAgent[]
  /**
   * Spell start for a worktree whose connection is up but whose conversations
   * have not been classified yet — a worktree still booting its agent. Without
   * it a booting worktree reads as `waiting` with no spell, and a client
   * keying unread marks on the spell has nothing to key on.
   */
  attachedWaitingSinceMs?: number
}

const store = new Map<string, WorktreeStatusEntry>()

let listener: (() => void) | null = null
let liveAgentsListener: (() => void) | null = null

function key(slug: string, worktreeId: string): string {
  return `${slug}/${worktreeId}`
}

/**
 * Register the handler fired whenever an entry's observable state
 * (status or stream health) changes. Replaces any previous handler —
 * same single-listener convention as `onWorktreeListChanged` (the server
 * is one process, and the one consumer fans out via the event hub).
 */
export function onWorktreeStatusChanged(fn: () => void): void {
  listener = fn
}

function notifyChanged(): void {
  listener?.()
}

/**
 * Register the handler fired when a worktree's *set* of live conversations
 * changes — one appeared, one went, or one finally learned its id. Separate
 * from `onWorktreeStatusChanged` on purpose: that one fires on every turn
 * boundary, and its consumer only pushes a snapshot. This one drives a
 * reconcile pass, and a pass per turn would be a pod sweep per turn.
 *
 * The signal matters most for `acp`, where the conversation id arrives from
 * the handshake rather than from a substrate event: nothing else would mark
 * the reconciler dirty, so the conversation's row — and the chat pane that
 * waits on it — would sit out the rest of the 60s resync interval.
 *
 * Single-listener, same convention as above.
 */
export function onLiveAgentsChanged(fn: () => void): void {
  liveAgentsListener = fn
}

function entry(k: string): WorktreeStatusEntry {
  const existing = store.get(k)
  if (existing) return existing
  const fresh: WorktreeStatusEntry = {
    streamHealthy: false,
    updatedAtMs: Date.now(),
    agents: new Map(),
  }
  store.set(k, fresh)
  return fresh
}

/**
 * The worktree's status: `waiting` if any of its agents is waiting, else
 * `running` if any is running, else `waiting` (nothing classified yet).
 */
export function readWorktreeStatus(slug: string, worktreeId: string): AgentPaneStatus {
  const agents = store.get(key(slug, worktreeId))?.agents
  if (!agents || agents.size === 0) return 'waiting'
  for (const a of agents.values()) if (a.status === 'waiting') return 'waiting'
  return 'running'
}

/**
 * Start of the worktree's current waiting spell (epoch ms), or undefined
 * while nothing is waiting. The *earliest* waiting conversation wins: a second
 * agent going idle joins the spell already in progress rather than restarting
 * it, so a client's per-spell read mark isn't cleared by an unrelated agent.
 */
export function readWorktreeWaitingSince(slug: string, worktreeId: string): number | undefined {
  const e = store.get(key(slug, worktreeId))
  if (!e) return undefined
  let earliest: number | undefined
  for (const a of e.agents.values()) {
    if (a.status !== 'waiting' || a.waitingSinceMs === undefined) continue
    if (earliest === undefined || a.waitingSinceMs < earliest) earliest = a.waitingSinceMs
  }
  // Nothing classified yet — the worktree is waiting on its agent to come up,
  // and that spell started when the connection attached.
  return earliest ?? (e.agents.size === 0 ? e.attachedWaitingSinceMs : undefined)
}

/** One conversation's status, for the per-agent dot on its tab. */
export function readAgentStatus(
  slug: string,
  worktreeId: string,
  handle: string,
): AgentStatusEntry | undefined {
  return store.get(key(slug, worktreeId))?.agents.get(handle)
}

/**
 * Every conversation the watcher currently sees running, or undefined when it
 * has not enumerated them yet. The agent-session registry joins this with each
 * mode's own history (the hook's pane pointers for `tui`, the recorded rows
 * for `acp`) to decide which conversations are active — and skips the update
 * entirely on undefined.
 */
export function liveAgents(slug: string, worktreeId: string): LiveAgent[] | undefined {
  return store.get(key(slug, worktreeId))?.liveAgents
}

/**
 * True when the worktree's watcher connection is currently healthy — i.e. a
 * driver is attached to the in-pod tmux server right now. Absent entry → false
 * (unknown, not dead).
 */
export function isWorktreeStreamHealthy(slug: string, worktreeId: string): boolean {
  return store.get(key(slug, worktreeId))?.streamHealthy ?? false
}

/**
 * Record a freshly classified status for one conversation. Creates the entry
 * (marked healthy — a classification only ever comes from a live connection)
 * and fires the change listener when the worktree's visible status actually
 * flipped, so a busy sibling doesn't spam every client.
 */
export function setAgentStatus(
  slug: string,
  worktreeId: string,
  handle: string,
  status: AgentPaneStatus,
): void {
  const k = key(slug, worktreeId)
  const before = readWorktreeStatus(slug, worktreeId)
  const hadEntry = store.has(k)
  const wasHealthy = store.get(k)?.streamHealthy ?? false
  const e = entry(k)
  const prev = e.agents.get(handle)
  // A waiting spell keeps its original stamp while waiting persists and
  // restarts whenever waiting is entered anew; running clears it.
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
  // Also fires when health became visible again: a classification proves the
  // connection is back, which clients render even when the status itself held.
  if (!hadEntry || !prev || !wasHealthy || readWorktreeStatus(slug, worktreeId) !== before) {
    notifyChanged()
  }
}

/**
 * Publish the conversations currently running an agent. Ones that vanished
 * lose their status with the same call — a classification for a conversation
 * that no longer exists would keep a dead agent's "waiting" in the aggregate
 * forever.
 */
export function setLiveAgents(slug: string, worktreeId: string, agents: LiveAgent[]): void {
  const k = key(slug, worktreeId)
  const before = readWorktreeStatus(slug, worktreeId)
  const e = entry(k)
  const next = new Set(agents.map((a) => a.handle))
  const previous = e.liveAgents
  const changed = previous === undefined
    || previous.length !== agents.length
    || agents.some((a) => !previous.some((p) =>
      p.handle === a.handle && p.agentSessionId === a.agentSessionId))
  e.liveAgents = agents
  for (const handle of [...e.agents.keys()]) if (!next.has(handle)) e.agents.delete(handle)
  e.updatedAtMs = Date.now()
  // A membership or id change is what the agent-session registry joins
  // against, so it gets its own notification: the reconcile pass it kicks is
  // how a just-handshaken ACP conversation becomes a row without waiting for
  // the resync.
  if (changed) liveAgentsListener?.()
  if (changed || readWorktreeStatus(slug, worktreeId) !== before) notifyChanged()
}

/**
 * Flip the stream-health bit while keeping the sticky status. Marking
 * an absent worktree healthy creates an entry: the attach itself proves
 * tmux is up even before the first classification lands. Marking an absent
 * worktree unhealthy is a no-op.
 */
export function setWorktreeStreamHealth(slug: string, worktreeId: string, healthy: boolean): void {
  const k = key(slug, worktreeId)
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
}

/**
 * Drop a worktree's entry. Called on teardown (cleanup.ts) and when the
 * watcher manager retires a worktree, so a restart that reuses the same
 * id never sees the previous life's status.
 */
export function evictWorktreeStatus(slug: string, worktreeId: string): void {
  if (store.delete(key(slug, worktreeId))) notifyChanged()
}

/** Test-only: drop every entry and the change listener. */
export function _resetWorktreeStatusStoreForTests(): void {
  store.clear()
  listener = null
  liveAgentsListener = null
}
