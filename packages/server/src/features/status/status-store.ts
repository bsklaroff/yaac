/**
 * Server-resident store of agent status, fed by the status watchers
 * (`status-watcher.ts`) and read by every display path (`/worktree/list`,
 * snapshots, the stream picker).
 *
 * Status is per *agent pane*, not per worktree: a worktree can hold several
 * agent sessions at once (a second terminal, or a `/clear` that left the old
 * conversation's window open), and each has its own busy/idle. The worktree's
 * own status — what the sidebar row shows — is an aggregate over its panes.
 *
 * Status is pushed into the store the moment a pane's OSC title (claude/codex)
 * or rendered content (opencode/pi) changes, so reads are synchronous map
 * lookups and never trigger a `kubectl exec`.
 *
 * Semantics:
 * - No pane entry → `waiting`. Matches the probe-era answer for a session
 *   that hasn't set a title yet (booting) or whose pod isn't exec-able yet.
 * - The worktree aggregate is `waiting` if ANY of its agents is waiting.
 *   Waiting is the actionable state — an agent that needs you needs you
 *   whether or not a sibling is still working.
 * - Status is sticky across watcher respawns: a dropped exec stream flips
 *   `streamHealthy` but keeps the last classified status, so a transient
 *   kubectl hiccup never flaps the UI.
 * - `streamHealthy` doubles as the display-path tmux-liveness signal: a
 *   healthy control-mode client is conclusive proof the in-pod tmux server is
 *   up. It is deliberately NOT a death signal — only the stale reaper's own
 *   probes may conclude `dead`.
 */

import type { SessionAgentStatus } from '#features/agents'

export type { SessionAgentStatus }

export interface PaneStatusEntry {
  status: SessionAgentStatus
  /** Epoch ms when this pane's current waiting spell began; set iff waiting. */
  waitingSinceMs?: number
  updatedAtMs: number
}

export interface SessionStatusEntry {
  /** True while the worktree's watcher stream is connected and classifying. */
  streamHealthy: boolean
  /** Epoch ms of the last write (status or health). */
  updatedAtMs: number
  /** Per-agent-pane status, keyed by tmux pane id (`%3`). */
  panes: Map<string, PaneStatusEntry>
  /**
   * Every pane the watcher last saw running an agent, or undefined before it
   * has ever enumerated them. The distinction matters: undefined means "not
   * known yet" and callers must not read it as "no agents are running", which
   * would make a stream gap look like every agent exiting.
   */
  livePanes?: Set<string>
  /**
   * Spell start for a worktree whose stream is attached but whose panes have
   * not been classified yet — a session still booting its agent. Without it a
   * booting worktree reads as `waiting` with no spell, and a client keying
   * unread marks on the spell has nothing to key on.
   */
  attachedWaitingSinceMs?: number
}

const store = new Map<string, SessionStatusEntry>()

let listener: (() => void) | null = null

function key(slug: string, worktreeId: string): string {
  return `${slug}/${worktreeId}`
}

/**
 * Register the handler fired whenever an entry's observable state
 * (status or stream health) changes. Replaces any previous handler —
 * same single-listener convention as `onSessionListChanged` (the server
 * is one process, and the one consumer fans out via the event hub).
 */
export function onSessionStatusChanged(fn: () => void): void {
  listener = fn
}

function notifyChanged(): void {
  listener?.()
}

function entry(k: string): SessionStatusEntry {
  const existing = store.get(k)
  if (existing) return existing
  const fresh: SessionStatusEntry = {
    streamHealthy: false,
    updatedAtMs: Date.now(),
    panes: new Map(),
  }
  store.set(k, fresh)
  return fresh
}

/**
 * The worktree's status: `waiting` if any of its agents is waiting, else
 * `running` if any is running, else `waiting` (nothing classified yet).
 */
export function readSessionStatus(slug: string, worktreeId: string): SessionAgentStatus {
  const panes = store.get(key(slug, worktreeId))?.panes
  if (!panes || panes.size === 0) return 'waiting'
  for (const p of panes.values()) if (p.status === 'waiting') return 'waiting'
  return 'running'
}

/**
 * Start of the worktree's current waiting spell (epoch ms), or undefined
 * while nothing is waiting. The *earliest* waiting pane wins: a second agent
 * going idle joins the spell already in progress rather than restarting it,
 * so a client's per-spell read mark isn't cleared by an unrelated agent.
 */
export function readSessionWaitingSince(slug: string, worktreeId: string): number | undefined {
  const e = store.get(key(slug, worktreeId))
  if (!e) return undefined
  let earliest: number | undefined
  for (const p of e.panes.values()) {
    if (p.status !== 'waiting' || p.waitingSinceMs === undefined) continue
    if (earliest === undefined || p.waitingSinceMs < earliest) earliest = p.waitingSinceMs
  }
  // Nothing classified yet — the worktree is waiting on its agent to come up,
  // and that spell started when the stream attached.
  return earliest ?? (e.panes.size === 0 ? e.attachedWaitingSinceMs : undefined)
}

/** One agent pane's status, for the per-agent dot on its tab. */
export function readPaneStatus(
  slug: string,
  worktreeId: string,
  paneId: string,
): PaneStatusEntry | undefined {
  return store.get(key(slug, worktreeId))?.panes.get(paneId)
}

/**
 * Every pane the watcher currently sees running an agent, or undefined when
 * it has not enumerated them yet. The agent-session registry intersects this
 * with the hook's pane pointers to decide which conversations are active —
 * and skips the update entirely on undefined.
 */
export function liveAgentPanes(slug: string, worktreeId: string): Set<string> | undefined {
  return store.get(key(slug, worktreeId))?.livePanes
}

/**
 * True when the worktree's watcher stream is currently healthy — i.e.
 * a control-mode client is attached to the in-pod tmux server right
 * now. Absent entry → false (unknown, not dead).
 */
export function isSessionStreamHealthy(slug: string, worktreeId: string): boolean {
  return store.get(key(slug, worktreeId))?.streamHealthy ?? false
}

/**
 * Record a freshly classified status for one agent pane. Creates the entry
 * (marked healthy — a classification only ever comes from a live stream) and
 * fires the change listener when the worktree's visible status actually
 * flipped, so a busy sibling doesn't spam every client.
 */
export function setPaneStatus(
  slug: string,
  worktreeId: string,
  paneId: string,
  status: SessionAgentStatus,
): void {
  const k = key(slug, worktreeId)
  const before = readSessionStatus(slug, worktreeId)
  const hadEntry = store.has(k)
  const wasHealthy = store.get(k)?.streamHealthy ?? false
  const e = entry(k)
  const prev = e.panes.get(paneId)
  // A waiting spell keeps its original stamp while waiting persists and
  // restarts whenever waiting is entered anew; running clears it.
  const waitingSinceMs = status === 'waiting'
    ? (prev?.status === 'waiting' && prev.waitingSinceMs !== undefined
      ? prev.waitingSinceMs
      : Date.now())
    : undefined
  e.panes.set(paneId, { status, updatedAtMs: Date.now(), ...(waitingSinceMs !== undefined ? { waitingSinceMs } : {}) })
  // A real classification supersedes the boot-time spell.
  delete e.attachedWaitingSinceMs
  e.streamHealthy = true
  e.updatedAtMs = Date.now()
  // Also fires when health became visible again: a classification proves the
  // stream is back, which clients render even when the status itself held.
  if (!hadEntry || !prev || !wasHealthy || readSessionStatus(slug, worktreeId) !== before) {
    notifyChanged()
  }
}

/**
 * Publish the panes currently running an agent. Panes that vanished lose
 * their status with the same call — a classification for a pane that no
 * longer exists would keep a dead agent's "waiting" in the aggregate forever.
 */
export function setLiveAgentPanes(slug: string, worktreeId: string, panes: string[]): void {
  const k = key(slug, worktreeId)
  const before = readSessionStatus(slug, worktreeId)
  const e = entry(k)
  const next = new Set(panes)
  const changed = e.livePanes === undefined
    || e.livePanes.size !== next.size
    || [...next].some((p) => !e.livePanes?.has(p))
  e.livePanes = next
  for (const paneId of [...e.panes.keys()]) if (!next.has(paneId)) e.panes.delete(paneId)
  e.updatedAtMs = Date.now()
  if (changed || readSessionStatus(slug, worktreeId) !== before) notifyChanged()
}

/**
 * Flip the stream-health bit while keeping the sticky status. Marking
 * an absent worktree healthy creates an entry: the attach itself proves
 * tmux is up even before the first classification lands. Marking an absent
 * worktree unhealthy is a no-op.
 */
export function setSessionStreamHealth(slug: string, worktreeId: string, healthy: boolean): void {
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
export function evictSessionStatus(slug: string, worktreeId: string): void {
  if (store.delete(key(slug, worktreeId))) notifyChanged()
}

/** Test-only: drop every entry and the change listener. */
export function _resetSessionStatusStoreForTests(): void {
  store.clear()
  listener = null
}
