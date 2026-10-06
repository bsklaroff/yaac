import { workspaceDriver } from '#drivers/driver'
import { findWorkspaceRow, listWorkspaceRows } from '#db'
import { listProvisioning } from './provisioning'
import type { RuntimeHandle } from '#drivers/contract'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface ResolvedWorkspace {
  jobName: string
  workspaceId: string
  projectId: string
  state: string
}

/**
 * Resolve a workspace id or unique prefix to its running unit. Throws
 * `VALIDATION` for empty or ambiguous input, `NOT_FOUND` if absent. Uses the
 * driver's cache, since several callers are polled.
 */
export async function resolveWorkspaceContainer(
  idOrPrefix: string,
  opts: { requireRunning?: boolean; exact?: boolean } = {},
): Promise<ResolvedWorkspace> {
  // `exact`: callers holding full ids (WebSocket attaches) accept no prefix.
  const id = opts.exact === true ? idOrPrefix : await resolveWorkspaceId(idOrPrefix)
  const match: RuntimeHandle | undefined =
    await workspaceDriver().find(id, { preferCache: true })
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrPrefix} not found`)

  if (opts.requireRunning && match.state !== 'running') {
    throw new ServerError('CONFLICT', `job "${match.jobName}" is not running (phase: ${match.state})`)
  }

  return {
    jobName: match.jobName,
    workspaceId: match.workspaceId,
    projectId: match.projectId,
    state: match.state,
  }
}

export interface ResolvedWorkspaceRecord {
  projectId: string
  workspaceId: string
  /** Absent when resolved from the row only (nothing running). */
  jobName?: string
  tool?: AgentTool
}

/**
 * Resolve a workspace in any state: the running unit first, then the row.
 * For callers reading recorded state, which stopped workspaces still have.
 */
export async function resolveWorkspaceRecord(
  idOrPrefix: string,
): Promise<ResolvedWorkspaceRecord> {
  const id = await resolveWorkspaceId(idOrPrefix)
  try {
    const match = await workspaceDriver().find(id)
    if (match) {
      return {
        projectId: match.projectId,
        workspaceId: match.workspaceId,
        jobName: match.jobName,
        tool: match.tool,
      }
    }
  } catch {
    // Substrate unreachable; fall back to the row.
  }
  const row = await findWorkspaceRow(id)
  if (row) return { projectId: row.projectId, workspaceId: row.workspaceId }
  throw new ServerError('NOT_FOUND', `workspace ${idOrPrefix} not found`)
}

/**
 * The result of resolving an id or prefix. Unknown and ambiguous are kept
 * apart because they need different fixes; an ambiguous prefix never picks
 * one.
 */
export type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' }

/**
 * Resolve a workspace id or unique prefix against rows (any state). The only
 * place prefixes are expanded; drivers take exact ids. An exact id beats a
 * prefix match. Unclaimed spares never match. `projectId` limits the
 * search to one project (for `yaac-mama` and the group routes).
 * `provisioning` also matches creates still in flight, whose row may not
 * exist yet (for a stop).
 */
export async function resolveWorkspace(
  idOrPrefix: string,
  opts: { projectId?: string; provisioning?: boolean } = {},
): Promise<WorkspaceResolution> {
  const trimmed = idOrPrefix.trim()
  if (trimmed === '') return { ok: false, reason: 'not-found' }
  const inFlight = opts.provisioning !== true ? [] : listProvisioning()
    .filter((p) => p.error === undefined
      && (opts.projectId === undefined || p.projectId === opts.projectId))
    .map((p) => p.workspaceId)
  // Exact ids are the common case and hit the primary key.
  const exact = await findWorkspaceRow(trimmed)
  if (inFlight.includes(trimmed)
    || (exact && (opts.projectId === undefined || exact.projectId === opts.projectId))) {
    return { ok: true, workspaceId: trimmed }
  }
  const matches = new Set([...(await listWorkspaceRows(opts.projectId)).map((r) => r.workspaceId), ...inFlight]
    .filter((id) => id.startsWith(trimmed)))
  if (matches.size === 1) return { ok: true, workspaceId: [...matches][0] }
  return { ok: false, reason: matches.size > 1 ? 'ambiguous' : 'not-found' }
}

/**
 * `resolveWorkspace` across projects, returning the exact id for the driver.
 * Throws for empty or ambiguous input. Unknown input passes through, so a
 * unit with no row (e.g. after a DB reset) is still reachable by full id.
 */
export async function resolveWorkspaceId(
  idOrPrefix: string,
  opts: { provisioning?: boolean } = {},
): Promise<string> {
  const trimmed = idOrPrefix.trim()
  if (trimmed === '') throw new ServerError('VALIDATION', 'a workspace id is required')
  const resolved = await resolveWorkspace(trimmed, opts)
  if (resolved.ok) return resolved.workspaceId
  if (resolved.reason === 'ambiguous') {
    throw new ServerError(
      'VALIDATION',
      `Ambiguous workspace prefix: ${trimmed} matches more than one workspace — use a longer prefix`,
    )
  }
  return trimmed
}
