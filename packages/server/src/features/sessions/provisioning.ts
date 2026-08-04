/**
 * In-memory registry of sessions that are currently provisioning (a create or
 * a restart in flight). Surfaced in the server snapshot so the webapp renders
 * them as first-class, selectable sidebar rows that survive a browser reload —
 * the snapshot is the source of truth pushed over `/events`, so a reconnecting
 * client re-hydrates the in-flight set with live progress. Failures are kept
 * until dismissed so the user still sees them after a reload.
 *
 * The server is a single process, so a module-level map is enough. Entries are
 * dropped by the create/restart routes the moment provisioning resolves, or by
 * the user dismissing a failed one. While an entry exists, `buildSnapshot`
 * hides any same-id active session — a pod lists well before its tmux windows
 * are set up, and clients must keep rendering the row, not attach to a
 * half-built session.
 */
import { toErrorBody } from '#http'
import { notifySessionListChanged } from '#features/sessions/notify'
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
 *  creating/restarting session is shown — entries are only dropped when the
 *  create/restart resolves (the routes remove them) or on dismiss. */
export function registerProvisioning(input: {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message?: string
}): void {
  entries.set(input.worktreeId, {
    worktreeId: input.worktreeId,
    projectSlug: input.projectSlug,
    tool: input.tool,
    kind: input.kind,
    message: input.message ?? 'Starting…',
    startedAt: Date.now(),
    seq: nextSeq++,
  })
  notifySessionListChanged()
}

/** Update the progress message of a tracked entry. No-op if absent — a late
 *  progress callback must not resurrect a removed or dismissed entry. */
export function updateProvisioningMessage(worktreeId: string, message: string): void {
  const e = entries.get(worktreeId)
  if (!e) return
  e.message = message
  delete e.error
  notifySessionListChanged()
}

/** Mark a tracked entry as failed; kept (no TTL) until dismissed. No-op if
 *  absent. */
export function failProvisioning(worktreeId: string, error: string): void {
  const e = entries.get(worktreeId)
  if (!e) return
  e.error = error
  notifySessionListChanged()
}

/** Drop an entry (provisioning resolved, or user dismissed). Notifies only if
 *  it actually removed something, to avoid a spurious broadcast. */
export function removeProvisioning(worktreeId: string): void {
  if (entries.delete(worktreeId)) notifySessionListChanged()
}

/**
 * Run a provisioning task with the row's lifecycle managed: each progress
 * message mirrors into the row, success drops it (plus a snapshot push so the
 * now-ready session lists in its place), failure marks it failed — kept until
 * dismissed — and rethrows. Registering the row is the caller's job; every
 * registry call here is a no-op while no row exists (e.g. the create route's
 * prewarm fast path). This is the single codepath behind every provisioning
 * surface: the HTTP create/restart streams layer NDJSON on top, and the
 * headless spawn reconciler calls it directly so its sessions
 * provision in the sidebar exactly like a user-initiated create.
 */
export async function runProvisioned<T>(
  worktreeId: string,
  run: (onProgress: (message: string) => void) => Promise<T>,
): Promise<T> {
  try {
    const result = await run((message) => updateProvisioningMessage(worktreeId, message))
    // Drop the row before the caller sees the result — its notify pushes the
    // snapshot that swaps it for the now-ready session (buildSnapshot hides
    // the session while the row exists), and a client gone mid-provision
    // can't leave the row stuck.
    removeProvisioning(worktreeId)
    notifySessionListChanged()
    return result
  } catch (err) {
    failProvisioning(worktreeId, toErrorBody(err).body.error.message)
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
      createdAt: formatUtcTimestamp(e.startedAt),
    }))
}

/** Test helper: drop all tracked entries. */
export function clearAllProvisioningForTests(): void {
  entries.clear()
}
