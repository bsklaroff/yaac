/**
 * In-memory registry of sessions that are currently provisioning (a create or
 * a restart in flight). Surfaced in the daemon snapshot so the webapp renders
 * them as first-class, selectable sidebar rows that survive a browser reload —
 * the snapshot is the source of truth pushed over `/events`, so a reconnecting
 * client re-hydrates the in-flight set with live progress. Failures are kept
 * until dismissed so the user still sees them after a reload.
 *
 * The daemon is a single process, so a module-level map is enough. Entries are
 * dropped when the real session lands in `listActiveSessions` (lazy cleanup in
 * `buildSnapshot`) or when the user dismisses a failed one.
 */
import { notifySessionListChanged } from '@/daemon/sessions-changed'
import type { AgentTool, ProvisioningSessionEntry } from '@/shared/types'

export type ProvisioningKind = 'create' | 'restart'

interface ProvisioningEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message: string
  error?: string
  startedAt: number
}

const entries = new Map<string, ProvisioningEntry>()

/** Same 'YYYY-MM-DD HH:MM:SS' UTC shape as session list `createdAt`, so the
 *  sidebar's relativeAge() renders a sane age for a row that has no pod yet. */
function formatCreated(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}

/** Track a new in-flight provision (idempotent overwrite on the same id, e.g.
 *  a retry). Pushes a fresh snapshot so the row appears immediately. Every
 *  creating/restarting session is shown — entries are only dropped when the
 *  real session lands (lazy cleanup in buildSnapshot) or on dismiss. */
export function registerProvisioning(input: {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  kind: ProvisioningKind
  message?: string
}): void {
  entries.set(input.sessionId, {
    sessionId: input.sessionId,
    projectSlug: input.projectSlug,
    tool: input.tool,
    kind: input.kind,
    message: input.message ?? 'Starting…',
    startedAt: Date.now(),
  })
  notifySessionListChanged()
}

/** Update the progress message of a tracked entry. No-op if absent — a late
 *  progress callback must not resurrect a removed or dismissed entry. */
export function updateProvisioningMessage(sessionId: string, message: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.message = message
  delete e.error
  notifySessionListChanged()
}

/** Mark a tracked entry as failed; kept (no TTL) until dismissed. No-op if
 *  absent. */
export function failProvisioning(sessionId: string, error: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.error = error
  notifySessionListChanged()
}

/** Drop an entry (real session landed, or user dismissed). Notifies only if it
 *  actually removed something, to avoid a spurious broadcast. */
export function removeProvisioning(sessionId: string): void {
  if (entries.delete(sessionId)) notifySessionListChanged()
}

/** Snapshot projection of the registry, oldest first. */
export function listProvisioning(): ProvisioningSessionEntry[] {
  return [...entries.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
    .map((e) => ({
      sessionId: e.sessionId,
      projectSlug: e.projectSlug,
      tool: e.tool,
      kind: e.kind,
      message: e.message,
      ...(e.error !== undefined ? { error: e.error } : {}),
      createdAt: formatCreated(e.startedAt),
    }))
}

/** Test helper: drop all tracked entries. */
export function clearAllProvisioningForTests(): void {
  entries.clear()
}
