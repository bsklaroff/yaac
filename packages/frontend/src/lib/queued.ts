import { api } from '#lib/api'
import type { QueuedWorkspaceEntry } from '@yaac/shared/types'

/**
 * Helpers over the snapshot's queued workspaces (docs/queued-workspaces.md).
 * Each entry waits on one parent (a workspace or another entry), so the
 * entries form trees rooted at workspace ids. One with no parent waits for
 * room in its group (docs/workspace-groups.md), and roots at `roomKey`,
 * unless it starts at a time (docs/routines.md): those head their own trees
 * in the sidebar's Scheduled section, and root at `SCHEDULED_KEY`.
 */

/** What entries that start at a time root at; nothing nests under it. */
export const SCHEDULED_KEY = 'at:'

/** What entries with no parent nest under: their group's section. */
export function roomKey(groupId: string | undefined): string {
  return `room:${groupId ?? ''}`
}

/** A queued entry's or draft's whole prompt, which the snapshot holds only
 *  a preview of (`PROMPT_PREVIEW_LENGTH`). */
export async function fetchFullPrompt(id: string): Promise<string> {
  return (await api.workspace.prompt.$get({ query: { id } })).prompt
}

/** The id an entry waits on, whichever kind it is. */
export function queuedParentId(entry: QueuedWorkspaceEntry): string {
  return entry.parentWorkspaceId ?? entry.parentQueuedId
    ?? (entry.startAt !== undefined ? SCHEDULED_KEY : roomKey(entry.groupId))
}

/** Entries grouped by the id they wait on, each list oldest first. */
export function queuedChildren(entries: QueuedWorkspaceEntry[]): Map<string, QueuedWorkspaceEntry[]> {
  const byParent = new Map<string, QueuedWorkspaceEntry[]>()
  for (const e of entries) {
    const key = queuedParentId(e)
    byParent.set(key, [...(byParent.get(key) ?? []), e])
  }
  return byParent
}

/** Every entry below `id` at any depth. Re-parenting `id` under one of these
 *  would create a cycle. */
export function queuedDescendants(entries: QueuedWorkspaceEntry[], id: string): Set<string> {
  const children = queuedChildren(entries)
  const out = new Set<string>()
  const walk = (parent: string): void => {
    for (const c of children.get(parent) ?? []) {
      if (out.has(c.id)) continue
      out.add(c.id)
      walk(c.id)
    }
  }
  walk(id)
  return out
}

/** Every entry in the order the sidebar draws them: each chain's top entry,
 *  then its descendants. */
export function queuedInTreeOrder(entries: QueuedWorkspaceEntry[]): QueuedWorkspaceEntry[] {
  const ids = new Set(entries.map((e) => e.id))
  const children = queuedChildren(entries)
  const out: QueuedWorkspaceEntry[] = []
  const seen = new Set<string>()
  const walk = (e: QueuedWorkspaceEntry): void => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
    for (const c of children.get(e.id) ?? []) walk(c)
  }
  for (const e of entries) if (e.parentQueuedId === undefined || !ids.has(e.parentQueuedId)) walk(e)
  return out
}

/** An entry's (or a draft's) label: the title it was given, else its
 *  generated one, else the first non-blank line of its prompt. */
export function queuedTitle(entry: Pick<QueuedWorkspaceEntry, 'prompt' | 'title' | 'generatedTitle'>): string {
  return entry.title ?? entry.generatedTitle ?? entry.prompt.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'Queued workspace'
}

/** Clip a label for dialog and dropdown copy. */
export function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
