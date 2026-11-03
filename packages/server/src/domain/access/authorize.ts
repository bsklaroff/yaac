import { getProjectRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { Principal } from '@yaac/shared/types'

/**
 * How much of a resource a caller asks for (docs/multi-user.md
 * "Authorization"): `reader` is any user; `owner` is the resource's owner
 * only, and covers every write plus the attaches that grant execution.
 */
export type AccessLevel = 'reader' | 'owner'

/**
 * Who a domain verb acts for: a request's principal, the server itself
 * (`systemPrincipal`), or a workspace's agent calling back through
 * yaac-mama, which acts as its project's owner.
 */
export type Actor =
  | Principal
  | { kind: 'system' }
  | { kind: 'workspace'; workspaceId: string; userId: string }

/**
 * The server acting on its own, for a gated verb it calls with no request
 * behind it (a queued workspace's launch). `identify()` never returns it,
 * so no request can claim it.
 */
export const systemPrincipal: Actor = { kind: 'system' }

/** Projects no one may write while a verb runs that a write would race,
 *  with why, by project id (`withProjectsHeld`). */
const holds = new Map<string, string>()

/**
 * Run `fn` while every write to `projectIds` is refused as CONFLICT with
 * `reason`, the server's own included: starts, restarts, queued launches,
 * routines and pushes to a hosted remote all authorize first. Refuses at
 * once if one is held already.
 */
export async function withProjectsHeld<T>(projectIds: string[], reason: string, fn: () => Promise<T>): Promise<T> {
  const held = projectIds.find((id) => holds.has(id))
  if (held !== undefined) throw new ServerError('CONFLICT', holds.get(held) as string)
  for (const id of projectIds) holds.set(id, reason)
  try {
    return await fn()
  } finally {
    for (const id of projectIds) holds.delete(id)
  }
}

/** Whether `withProjectsHeld` holds the project, for a server loop that
 *  should wait the hold out rather than be refused by it. */
export function isProjectHeld(projectId: string): boolean {
  return holds.has(projectId)
}

/** A project's owner. A project that does not exist is `NOT_FOUND`, since
 *  some verbs authorize before they check the project exists. A share its
 *  source's owner removed is FORBIDDEN to everyone, the server included,
 *  and a held project (`withProjectsHeld`) is CONFLICT. */
async function projectOwner(projectId: string): Promise<string> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (row.shareRevoked) throw new ServerError('FORBIDDEN', `${row.name} is no longer shared with its owner`)
  const held = holds.get(projectId)
  if (held !== undefined) throw new ServerError('CONFLICT', held)
  return row.owner
}

/**
 * Refuse with FORBIDDEN unless `principal` owns the project, and so
 * everything in it (docs/multi-user.md "Authorization"): the check every
 * user-caused write, and every attach, makes before its first side effect.
 * Reads need no check, since every user may read every resource.
 */
export async function authorizeProject(principal: Actor, projectId: string): Promise<void> {
  const owner = await projectOwner(projectId)
  if (principal.kind !== 'system' && principal.userId !== owner) {
    throw new ServerError('FORBIDDEN', 'only the owner of this project may do that')
  }
}

/**
 * The actor a workspace's yaac-mama call runs as: the calling workspace,
 * acting as its project's owner.
 */
export async function workspacePrincipal(workspaceId: string, projectId: string): Promise<Actor> {
  return { kind: 'workspace', workspaceId, userId: await projectOwner(projectId) }
}
