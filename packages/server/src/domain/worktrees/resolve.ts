import { findWorkspace } from '#runtime/k8s/worktrees'
import { findWorktreeRow } from '#records'
import type { RuntimeHandle } from '#runtime/contract'
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
    await findWorkspace(idOrName, { preferCache: true })
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
    const match = await findWorkspace(idOrName)
    if (match) return { projectSlug: match.projectSlug, worktreeId: match.workspaceId }
  } catch {
    // Substrate unreachable — the row still answers.
  }
  const row = await findWorktreeRow(idOrName)
  if (row) return { projectSlug: row.projectSlug, worktreeId: row.worktreeId }
  throw new ServerError('NOT_FOUND', `worktree ${idOrName} not found`)
}
