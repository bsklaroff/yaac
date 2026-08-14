import { worktreeDriver } from '#drivers/driver'
import { findWorktreeRow, getProjectWorktreeRows } from '#db'
import type { RuntimeHandle } from '#drivers/contract'
import { ServerError } from '@yaac/shared/errors'

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
): Promise<{ projectSlug: string; worktreeId: string }> {
  try {
    const match = await worktreeDriver().find(idOrName)
    if (match) return { projectSlug: match.projectSlug, worktreeId: match.workspaceId }
  } catch {
    // Substrate unreachable — the row still answers.
  }
  const row = await findWorktreeRow(idOrName)
  if (row) return { projectSlug: row.projectSlug, worktreeId: row.worktreeId }
  throw new ServerError('NOT_FOUND', `worktree ${idOrName} not found`)
}

/**
 * Resolve a session id, or its unique short prefix, WITHIN one project.
 *
 * Project-scoped by construction rather than by a check afterwards: this is
 * what an in-worktree caller uses (`yaac-mama`) and what the name-addressed
 * group routes use, and neither may reach a worktree in another project. An
 * id from elsewhere simply is not in this project's rows, so there is no
 * cross-project case to refuse separately.
 *
 * `null` for both "no such session" and "that prefix names several" — a move
 * or a rename aimed at the wrong session is silent, so an ambiguous prefix
 * must not resolve to whichever row came back first. Rows in any state
 * match: a stopped worktree keeps its title and its group.
 */
export async function resolveSessionInProject(
  projectSlug: string,
  session: string,
): Promise<string | null> {
  const trimmed = session.trim()
  if (trimmed === '') return null
  const rows = await getProjectWorktreeRows(projectSlug)
  if (rows.has(trimmed)) return trimmed
  const matches = [...rows.keys()].filter((id) => id.startsWith(trimmed))
  return matches.length === 1 ? matches[0] : null
}
