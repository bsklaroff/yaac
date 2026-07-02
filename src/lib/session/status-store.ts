/**
 * Daemon-resident store of per-session agent status, fed by the status
 * watchers (`src/daemon/status-watcher.ts`) and read by every display
 * path (`/session/list`, snapshots, the stream picker).
 *
 * This replaces the per-tool probe-plus-TTL-cache stacks: status is
 * pushed into the store the moment the pane's OSC title (claude/codex)
 * or rendered pane (opencode) changes, so reads are synchronous map
 * lookups and never trigger a `kubectl exec`.
 *
 * Semantics:
 * - Absent entry → `waiting`. Matches the probe-era answer for a
 *   session that hasn't set a title yet (booting) or whose pod isn't
 *   exec-able yet.
 * - Status is sticky across watcher respawns: a dropped exec stream
 *   flips `streamHealthy` but keeps the last classified status, so a
 *   transient kubectl hiccup never flaps the UI.
 * - `streamHealthy` doubles as the display-path tmux-liveness signal: a
 *   healthy control-mode client is conclusive proof the in-pod tmux
 *   server is up. It is deliberately NOT a death signal — only the
 *   stale reaper's own probes may conclude `dead`.
 */

export type SessionAgentStatus = 'running' | 'waiting'

export interface SessionStatusEntry {
  status: SessionAgentStatus
  /** True while the session's watcher stream is connected and classifying. */
  streamHealthy: boolean
  /** Epoch ms of the last write (status or health). */
  updatedAtMs: number
}

const store = new Map<string, SessionStatusEntry>()

let listener: (() => void) | null = null

function key(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

/**
 * Register the handler fired whenever an entry's observable state
 * (status or stream health) changes. Replaces any previous handler —
 * same single-listener convention as `onSessionListChanged` (the daemon
 * is one process, and the one consumer fans out via the event hub).
 */
export function onSessionStatusChanged(fn: () => void): void {
  listener = fn
}

function notifyChanged(): void {
  listener?.()
}

/** Current status for a session; `waiting` when nothing is stored. */
export function readSessionStatus(slug: string, sessionId: string): SessionAgentStatus {
  return store.get(key(slug, sessionId))?.status ?? 'waiting'
}

/**
 * True when the session's watcher stream is currently healthy — i.e.
 * a control-mode client is attached to the in-pod tmux server right
 * now. Absent entry → false (unknown, not dead).
 */
export function isSessionStreamHealthy(slug: string, sessionId: string): boolean {
  return store.get(key(slug, sessionId))?.streamHealthy ?? false
}

/**
 * Record a freshly classified status. Creates the entry (marked
 * healthy — a classification only ever comes from a live stream) and
 * fires the change listener when the visible status actually flipped.
 */
export function setSessionStatus(slug: string, sessionId: string, status: SessionAgentStatus): void {
  const k = key(slug, sessionId)
  const prev = store.get(k)
  store.set(k, { status, streamHealthy: true, updatedAtMs: Date.now() })
  if (!prev || prev.status !== status || !prev.streamHealthy) notifyChanged()
}

/**
 * Flip the stream-health bit while keeping the sticky status. Marking
 * an absent session healthy creates a `waiting` entry: the attach
 * itself proves tmux is up even before the first classification lands.
 * Marking an absent session unhealthy is a no-op.
 */
export function setSessionStreamHealth(slug: string, sessionId: string, healthy: boolean): void {
  const k = key(slug, sessionId)
  const prev = store.get(k)
  if (!prev) {
    if (!healthy) return
    store.set(k, { status: 'waiting', streamHealthy: true, updatedAtMs: Date.now() })
    notifyChanged()
    return
  }
  if (prev.streamHealthy === healthy) return
  store.set(k, { ...prev, streamHealthy: healthy, updatedAtMs: Date.now() })
  notifyChanged()
}

/**
 * Drop a session's entry. Called on teardown (cleanup.ts) and when the
 * watcher manager retires a session, so a restart that reuses the same
 * id never sees the previous session's status.
 */
export function evictSessionStatus(slug: string, sessionId: string): void {
  if (store.delete(key(slug, sessionId))) notifyChanged()
}

/** Test-only: drop every entry and the change listener. */
export function _resetSessionStatusStoreForTests(): void {
  store.clear()
  listener = null
}
