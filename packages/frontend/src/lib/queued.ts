import type { QueuedWorktreeEntry } from '@yaac/shared/types'

/**
 * Pure helpers over the snapshot's queued worktrees (docs/queued-worktrees.md).
 * An entry waits on exactly one parent — a worktree or another entry — so the
 * entries form a forest hanging off worktree ids.
 */

/** The id an entry waits on, whichever kind it is. */
export function queuedParentId(entry: QueuedWorktreeEntry): string {
  return entry.parentWorktreeId ?? entry.parentQueuedId ?? ''
}

/** Entries by the id they wait on, each list in snapshot order (oldest
 *  first, which is the order they will be shown in). */
export function queuedChildren(entries: QueuedWorktreeEntry[]): Map<string, QueuedWorktreeEntry[]> {
  const byParent = new Map<string, QueuedWorktreeEntry[]>()
  for (const e of entries) {
    const key = queuedParentId(e)
    byParent.set(key, [...(byParent.get(key) ?? []), e])
  }
  return byParent
}

/** `id`'s entries below it, at any depth — what re-parenting it under would
 *  make a cycle of. */
export function queuedDescendants(entries: QueuedWorktreeEntry[], id: string): Set<string> {
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

/** Every entry in tree order: each chain top, then its chain beneath it —
 *  the order the sidebar draws them. */
export function queuedInTreeOrder(entries: QueuedWorktreeEntry[]): QueuedWorktreeEntry[] {
  const ids = new Set(entries.map((e) => e.id))
  const children = queuedChildren(entries)
  const out: QueuedWorktreeEntry[] = []
  const seen = new Set<string>()
  const walk = (e: QueuedWorktreeEntry): void => {
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
export function queuedTitle(entry: Pick<QueuedWorktreeEntry, 'prompt' | 'title' | 'generatedTitle'>): string {
  return entry.title ?? entry.generatedTitle ?? entry.prompt.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'Queued worktree'
}

/** Clip a label for dialog and dropdown copy. */
export function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
