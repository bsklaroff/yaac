import { workspaceDriver } from '#drivers/driver'
import { findWorkspaceRow, listWorkspaceRows } from '#db'
import type { RuntimeHandle } from '#drivers/contract'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface ResolvedWorkspace {
  jobName: string
  workspaceId: string
  projectSlug: string
  state: string
}

/**
 * Resolve a workspace id, or its unique prefix, to the running unit hosting
 * it. Throws `ServerError` codes: `VALIDATION` for an empty or ambiguous
 * input, `NOT_FOUND` for nothing there.
 *
 * Every workspace endpoint resolves through here and several of them are
 * polled, so it asks for the cache-preferred match: the informer's push-fed
 * view answers without a subprocess, falling back to a live listing on a
 * miss.
 */
export async function resolveWorkspaceContainer(
  idOrPrefix: string,
  opts: { requireRunning?: boolean; exact?: boolean } = {},
): Promise<ResolvedWorkspace> {
  // `exact` for a caller that only ever holds full ids — the WebSocket
  // attaches — so nothing shorter can reach a unit through it.
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
    projectSlug: match.projectSlug,
    state: match.state,
  }
}

export interface ResolvedWorkspaceRecord {
  projectSlug: string
  workspaceId: string
  /** The running workspace's, when the substrate had one to give. Absent for
   *  a row-only resolve, so a reader that can only answer from inside the
   *  container (opencode keeps its history there) knows there is nothing to
   *  ask rather than dialling a workspace that is gone. */
  jobName?: string
  tool?: AgentTool
}

/**
 * Resolve a workspace whatever state it is in — running pod first, then the
 * recorded row.
 *
 * The pod-only resolver above answers "which container", so it rightly fails
 * when there is none. Anything that reads *recorded* state must not: a
 * stopped workspace keeps its row, its checkout and its conversation links,
 * and listing those is exactly what you do before restarting it. Restart
 * falls back the same way, for the same reason.
 */
export async function resolveWorkspaceRecord(
  idOrPrefix: string,
): Promise<ResolvedWorkspaceRecord> {
  const id = await resolveWorkspaceId(idOrPrefix)
  try {
    const match = await workspaceDriver().find(id)
    if (match) {
      return {
        projectSlug: match.projectSlug,
        workspaceId: match.workspaceId,
        jobName: match.jobName,
        tool: match.tool,
      }
    }
  } catch {
    // Substrate unreachable — the row still answers.
  }
  const row = await findWorkspaceRow(id)
  if (row) return { projectSlug: row.projectSlug, workspaceId: row.workspaceId }
  throw new ServerError('NOT_FOUND', `workspace ${idOrPrefix} not found`)
}

/**
 * What a workspace id, or its short prefix, resolved to within one project.
 *
 * The two failures are told apart because they ask the caller for different
 * things: an unknown id means look again, an ambiguous prefix means type
 * more of the one you already have. Reported rather than resolved — a move,
 * a rename or a STOP aimed at the wrong workspace is silent, so a prefix
 * naming several must never land on whichever row came back first.
 */
export type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' }

/**
 * Resolve a workspace id, or its unique short prefix — the one place prefix
 * expansion happens. Everything below domain takes an exact id: the drivers
 * match a workspace id and nothing else, so an input that reached them fuzzy
 * would land on whichever unit came back first.
 *
 * An exact id wins over a prefix it happens to share, and only a prefix
 * naming exactly one workspace resolves. Unclaimed spares are not workspaces
 * and never match, by id or prefix.
 *
 * With `projectSlug` it is project-scoped by construction rather than by a
 * check afterwards: this is what an in-workspace caller uses (`yaac-mama`) and
 * what the name-addressed group routes use, and neither may reach a
 * workspace in another project. An id from elsewhere simply is not in this
 * project's rows, so there is no cross-project case to refuse separately —
 * and for the same reason an `ambiguous` answer says nothing about anywhere
 * else.
 *
 * Rows in any state match: a stopped workspace keeps its title and its group.
 */
export async function resolveWorkspace(
  idOrPrefix: string,
  opts: { projectSlug?: string } = {},
): Promise<WorkspaceResolution> {
  const trimmed = idOrPrefix.trim()
  if (trimmed === '') return { ok: false, reason: 'not-found' }
  // Exact is the overwhelmingly common case — the webapp and every internal
  // caller pass a full id — and answers from the primary key; only a
  // human-typed prefix pays for the scan.
  const exact = await findWorkspaceRow(trimmed)
  if (exact && (opts.projectSlug === undefined || exact.projectSlug === opts.projectSlug)) {
    return { ok: true, workspaceId: trimmed }
  }
  const matches = (await listWorkspaceRows(opts.projectSlug))
    .filter((r) => r.workspaceId.startsWith(trimmed))
  if (matches.length === 1) return { ok: true, workspaceId: matches[0].workspaceId }
  return { ok: false, reason: matches.length > 1 ? 'ambiguous' : 'not-found' }
}

/**
 * `resolveWorkspace` across projects, as the exact id to hand the runtime —
 * throwing for the inputs that must never reach it: an empty one, and a
 * prefix naming several workspaces.
 *
 * An input no row knows passes through as-is, to be matched exactly: a unit
 * the database has no record of (a reset or restored DB) is still reachable
 * by its full id, and never by anything shorter.
 */
export async function resolveWorkspaceId(idOrPrefix: string): Promise<string> {
  const trimmed = idOrPrefix.trim()
  if (trimmed === '') throw new ServerError('VALIDATION', 'a workspace id is required')
  const resolved = await resolveWorkspace(trimmed)
  if (resolved.ok) return resolved.workspaceId
  if (resolved.reason === 'ambiguous') {
    throw new ServerError(
      'VALIDATION',
      `Ambiguous workspace prefix: ${trimmed} matches more than one workspace — use a longer prefix`,
    )
  }
  return trimmed
}
