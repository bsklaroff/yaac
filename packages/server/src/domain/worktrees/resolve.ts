import { worktreeDriver } from '#drivers/driver'
import { findWorktreeRow, getProjectWorktreeRows } from '#db'
import type { RuntimeHandle } from '#drivers/contract'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface ResolvedWorktree {
  jobName: string
  worktreeId: string
  projectSlug: string
  state: string
}

/**
 * Resolve a worktree by worktree ID (full or prefix), Job name, or Pod name
 * prefix. Mirrors the CLI-side matching but throws `ServerError` codes
 * instead of writing to stderr.
 *
 * Every worktree endpoint resolves through here and several of them are
 * polled, so it asks for the cache-preferred match: the informer's push-fed
 * view answers without a subprocess, falling back to a live listing on a
 * miss.
 */
export async function resolveWorktreeContainer(
  idOrName: string,
  opts: { requireRunning?: boolean } = {},
): Promise<ResolvedWorktree> {
  const match: RuntimeHandle | undefined =
    await worktreeDriver().find(idOrName, { preferCache: true })
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrName} not found`)

  if (opts.requireRunning && match.state !== 'running') {
    throw new ServerError('CONFLICT', `job "${match.jobName}" is not running (phase: ${match.state})`)
  }

  return {
    jobName: match.jobName,
    worktreeId: match.workspaceId,
    projectSlug: match.projectSlug,
    state: match.state,
  }
}

export interface ResolvedWorktreeRecord {
  projectSlug: string
  worktreeId: string
  /** The running workspace's, when the substrate had one to give. Absent for
   *  a row-only resolve, so a reader that can only answer from inside the
   *  container (opencode keeps its history there) knows there is nothing to
   *  ask rather than dialling a workspace that is gone. */
  jobName?: string
  tool?: AgentTool
}

/**
 * Resolve a worktree whatever state it is in — running pod first, then the
 * recorded row.
 *
 * The pod-only resolver above answers "which container", so it rightly fails
 * when there is none. Anything that reads *recorded* state must not: a
 * stopped worktree keeps its row, its checkout and its conversation links,
 * and listing those is exactly what you do before restarting it. Restart
 * falls back the same way, for the same reason.
 */
export async function resolveWorktreeRecord(
  idOrName: string,
): Promise<ResolvedWorktreeRecord> {
  try {
    const match = await worktreeDriver().find(idOrName)
    if (match) {
      return {
        projectSlug: match.projectSlug,
        worktreeId: match.workspaceId,
        jobName: match.jobName,
        tool: match.tool,
      }
    }
  } catch {
    // Substrate unreachable — the row still answers.
  }
  const row = await findWorktreeRow(idOrName)
  if (row) return { projectSlug: row.projectSlug, worktreeId: row.worktreeId }
  throw new ServerError('NOT_FOUND', `worktree ${idOrName} not found`)
}

/**
 * What a session id, or its short prefix, resolved to within one project.
 *
 * The two failures are told apart because they ask the caller for different
 * things: an unknown id means look again, an ambiguous prefix means type
 * more of the one you already have. Reported rather than resolved — a move,
 * a rename or a STOP aimed at the wrong session is silent, so a prefix
 * naming several must never land on whichever row came back first.
 */
export type SessionResolution =
  | { ok: true; worktreeId: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' }

/**
 * Resolve a session id, or its unique short prefix, WITHIN one project.
 *
 * Project-scoped by construction rather than by a check afterwards: this is
 * what an in-worktree caller uses (`yaac-mama`) and what the name-addressed
 * group routes use, and neither may reach a worktree in another project. An
 * id from elsewhere simply is not in this project's rows, so there is no
 * cross-project case to refuse separately — and for the same reason an
 * `ambiguous` answer says nothing about anywhere else.
 *
 * Rows in any state match: a stopped worktree keeps its title and its group.
 */
export async function resolveSessionInProject(
  projectSlug: string,
  session: string,
): Promise<SessionResolution> {
  const trimmed = session.trim()
  if (trimmed === '') return { ok: false, reason: 'not-found' }
  const rows = await getProjectWorktreeRows(projectSlug)
  if (rows.has(trimmed)) return { ok: true, worktreeId: trimmed }
  const matches = [...rows.keys()].filter((id) => id.startsWith(trimmed))
  if (matches.length === 1) return { ok: true, worktreeId: matches[0] }
  return { ok: false, reason: matches.length > 1 ? 'ambiguous' : 'not-found' }
}
