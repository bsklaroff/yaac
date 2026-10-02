import { newlyWaiting, waitingKeys } from '@yaac/shared/waiting'
import type { ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Turns server snapshots into the "needs attention" signal the shell shows
 * (dock badge and notifications). main.ts owns the Electron side effects.
 */

/** Dock-badge string for a waiting count (empty clears the badge). */
export function badgeText(waitingCount: number): string {
  return waitingCount > 0 ? String(waitingCount) : ''
}

/** Title + body for a "workspace is waiting" OS notification, labelled by
 *  title, else prompt, else id. */
export function notificationFor(s: WorkspaceListEntry): { title: string; body: string } {
  return { title: 'Workspace waiting for you', body: `${s.projectSlug} · ${s.title ?? s.prompt ?? s.workspaceId}` }
}

/**
 * Folds successive snapshots into the waiting count and the workspaces that
 * just started waiting. The first snapshot only seeds state, so connecting to
 * a server with existing waits doesn't fire a burst of notifications.
 */
export class AttentionMonitor {
  private prevKeys: Set<string> = new Set()
  private seeded = false

  update(snapshot: ServerSnapshot): { waitingCount: number; toNotify: WorkspaceListEntry[] } {
    const toNotify = this.seeded ? newlyWaiting(this.prevKeys, snapshot.workspaces) : []
    this.prevKeys = waitingKeys(snapshot.workspaces)
    this.seeded = true
    return { waitingCount: this.prevKeys.size, toNotify }
  }
}
