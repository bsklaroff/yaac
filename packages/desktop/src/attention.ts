import type { AgentTool, ServerSnapshot } from '@yaac/shared/types'

/**
 * The attention model: turn a server snapshot into the "needs me" signal the
 * desktop shell surfaces (dock badge + notifications). All pure so it's
 * headless-unit-testable; main.ts owns the Electron side effects.
 */

export interface WaitingWorkspace {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /** Display label: title, else the prompt, else the id. */
  title: string
  waitingSinceMs?: number
}

/** The subset of a snapshot's workspaces that are awaiting input. */
export function selectWaiting(snapshot: ServerSnapshot): WaitingWorkspace[] {
  return snapshot.workspaces
    .filter((s) => s.status === 'waiting')
    .map((s) => ({
      workspaceId: s.workspaceId,
      projectSlug: s.projectSlug,
      tool: s.tool,
      title: s.title ?? s.prompt ?? s.workspaceId,
      waitingSinceMs: s.waitingSinceMs,
    }))
}

/**
 * Identity for a single waiting *spell*: the workspace plus when the wait began.
 * A fresh spell (new `waitingSinceMs`) yields a new key so it re-notifies;
 * an ongoing wait keeps its key so it doesn't.
 */
export function waitingKey(s: WaitingWorkspace): string {
  return `${s.workspaceId}#${s.waitingSinceMs ?? ''}`
}

/** Which waiting workspaces are new since `prevKeys`, plus the next key set. */
export function diffNewlyWaiting(
  prevKeys: ReadonlySet<string>,
  waiting: readonly WaitingWorkspace[],
): { toNotify: WaitingWorkspace[]; nextKeys: Set<string> } {
  const nextKeys = new Set<string>()
  const toNotify: WaitingWorkspace[] = []
  for (const s of waiting) {
    const k = waitingKey(s)
    nextKeys.add(k)
    if (!prevKeys.has(k)) toNotify.push(s)
  }
  return { toNotify, nextKeys }
}

/** Dock-badge string for a waiting count (empty clears the badge). */
export function badgeText(waitingCount: number): string {
  return waitingCount > 0 ? String(waitingCount) : ''
}

/** Title + body for a "workspace is waiting" OS notification. */
export function notificationFor(s: WaitingWorkspace): { title: string; body: string } {
  return { title: 'Workspace waiting for you', body: `${s.projectSlug} · ${s.title}` }
}

/**
 * Parse a raw `/events` frame; return the snapshot payload, or null for
 * anything that isn't a `snapshot` event (or is malformed).
 */
export function parseSnapshotMessage(raw: string): ServerSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown }
    if (parsed.type === 'snapshot' && parsed.data !== null && typeof parsed.data === 'object') {
      return parsed.data as ServerSnapshot
    }
  } catch {
    // malformed frame — ignore
  }
  return null
}

/**
 * Folds successive snapshots into the current waiting count and the workspaces
 * that *just* entered a wait. The first snapshot only seeds state (returns no
 * notifications), so connecting to a server with pre-existing waits doesn't
 * fire a burst — and reconnects reuse the same monitor, so they don't re-notify
 * ongoing waits either.
 */
export class AttentionMonitor {
  private prevKeys: Set<string> = new Set()
  private seeded = false

  update(snapshot: ServerSnapshot): { waitingCount: number; toNotify: WaitingWorkspace[] } {
    const waiting = selectWaiting(snapshot)
    const { toNotify, nextKeys } = diffNewlyWaiting(this.prevKeys, waiting)
    this.prevKeys = nextKeys
    const notify = this.seeded ? toNotify : []
    this.seeded = true
    return { waitingCount: waiting.length, toNotify: notify }
  }
}
