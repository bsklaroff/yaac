/**
 * In-memory registry of worktrees that are currently provisioning (a create or
 * a restart in flight). Surfaced in the server snapshot so the webapp renders
 * them as first-class, selectable sidebar rows that survive a browser reload —
 * the snapshot is the source of truth pushed over `/events`, so a reconnecting
 * client re-hydrates the in-flight set with live progress. Failures are kept
 * until dismissed so the user still sees them after a reload.
 *
 * The server is a single process, so a module-level map is enough. Entries are
 * dropped by the create/restart routes the moment provisioning resolves, or by
 * the user dismissing a failed one. While an entry exists, `buildSnapshot`
 * hides any same-id active worktree — a pod lists well before its tmux windows
 * are set up, and clients must keep rendering the row, not attach to a
 * half-built worktree.
 */
import { notifyWorktreeListChanged } from '#notify'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentTool, ProvisioningWorktreeEntry } from '@yaac/shared/types'

export type ProvisioningKind = 'create' | 'restart'

interface ProvisioningEntry {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message: string
  error?: string
  /** Group this worktree is filed under — what the create asked for, or what
   *  the restarting worktree's row already says — so the row renders in its
   *  sidebar section while it provisions instead of at the top of the list.
   *  The worktree row carries the durable membership. */
  groupId?: string
  startedAt: number
  /** Monotonic insertion order, the sort tiebreak. `startedAt` (a wall-clock
   *  ms read) can tie or straddle a millisecond between two back-to-back
   *  registers, which flips their order under load; this never does. */
  seq: number
}

const entries = new Map<string, ProvisioningEntry>()
let nextSeq = 0

/** Track a new in-flight provision (idempotent overwrite on the same id, e.g.
 *  a retry). Pushes a fresh snapshot so the row appears immediately. Every
 *  creating/restarting worktree is shown — entries are only dropped when the
 *  create/restart resolves (the routes remove them) or on dismiss. */
export function registerProvisioning(input: {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message?: string
  groupId?: string
}): void {
  entries.set(input.worktreeId, {
    worktreeId: input.worktreeId,
    projectSlug: input.projectSlug,
    tool: input.tool,
    kind: input.kind,
    message: input.message ?? 'Starting…',
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    startedAt: Date.now(),
    seq: nextSeq++,
  })
  notifyWorktreeListChanged()
}

/**
 * Register only if this worktree has no entry yet.
 *
 * For a caller that must be tracked but may have been registered already by
 * the route above it: re-registering would reset `startedAt` and take a
 * fresh `seq`, which reorders a row the user is already watching, and would
 * clear an `error` a failed attempt is still displaying.
 *
 * Distinct from `registerProvisioning`'s deliberate overwrite, which is what
 * a genuine re-attempt on the same id wants.
 */
export function ensureProvisioning(input: {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message?: string
  groupId?: string
}): void {
  if (entries.has(input.worktreeId)) return
  registerProvisioning(input)
}

/** Update the progress message of a tracked entry. No-op if absent — a late
 *  progress callback must not resurrect a removed or dismissed entry. */
export function updateProvisioningMessage(worktreeId: string, message: string): void {
  const e = entries.get(worktreeId)
  if (!e) return
  e.message = message
  delete e.error
  notifyWorktreeListChanged()
}

/** Mark a tracked entry as failed; kept (no TTL) until dismissed. No-op if
 *  absent. */
export function failProvisioning(worktreeId: string, error: string): void {
  const e = entries.get(worktreeId)
  if (!e) return
  e.error = error
  notifyWorktreeListChanged()
}

/** Drop an entry (provisioning resolved, or user dismissed). Notifies only if
 *  it actually removed something, to avoid a spurious broadcast. */
export function removeProvisioning(worktreeId: string): void {
  if (entries.delete(worktreeId)) notifyWorktreeListChanged()
}

/**
 * Run a provisioning task with the row's lifecycle managed: each progress
 * message mirrors into the row, success drops it (plus a snapshot push so the
 * now-ready worktree lists in its place), failure marks it failed — kept until
 * dismissed — and rethrows. Registering the row is the caller's job; every
 * registry call here is a no-op while no row exists (e.g. the create route's
 * prewarm fast path). This is the single codepath behind every provisioning
 * surface: the HTTP create/restart streams layer NDJSON on top, and the
 * headless spawn reconciler calls it directly so its worktrees
 * provision in the sidebar exactly like a user-initiated create.
 */
export async function runProvisioned<T>(
  worktreeId: string,
  run: (onProgress: (message: string) => void) => Promise<T>,
): Promise<T> {
  try {
    const result = await run((message) => updateProvisioningMessage(worktreeId, message))
    // Drop the row before the caller sees the result — its notify pushes the
    // snapshot that swaps it for the now-ready worktree (buildSnapshot hides
    // the worktree while the row exists), and a client gone mid-provision
    // can't leave the row stuck.
    removeProvisioning(worktreeId)
    notifyWorktreeListChanged()
    return result
  } catch (err) {
    failProvisioning(worktreeId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

/** Snapshot projection of the registry, oldest first (by insertion order). */
export function listProvisioning(): ProvisioningWorktreeEntry[] {
  return [...entries.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
    .map((e) => ({
      worktreeId: e.worktreeId,
      projectSlug: e.projectSlug,
      tool: e.tool,
      kind: e.kind,
      message: e.message,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
      createdAt: formatUtcTimestamp(e.startedAt),
    }))
}

/**
 * The ids a sweep must not touch: worktrees this server is still creating
 * or restarting, so it owns their whole lifecycle.
 *
 * A FAILED entry is excluded and that exclusion is the point: its row lingers
 * with no TTL until the user dismisses it, and its own rollback has already
 * torn down whatever it left, so it is not still running and must shield
 * nothing from the reaper.
 */
export function inFlightWorktreeIds(): string[] {
  return [...entries.values()].filter((e) => e.error === undefined).map((e) => e.worktreeId)
}

/** Test helper: drop all tracked entries. */
export function clearAllProvisioningForTests(): void {
  entries.clear()
}
