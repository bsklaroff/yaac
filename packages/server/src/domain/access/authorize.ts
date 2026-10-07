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

/** A project's owner. A project that does not exist is `NOT_FOUND`, since
 *  some verbs authorize before they check the project exists. */
async function projectOwner(projectId: string): Promise<string> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return row.owner
}

/**
 * Refuse with FORBIDDEN unless `principal` owns the project, and so
 * everything in it (docs/multi-user.md "Authorization"): the check every
 * user-caused write, and every attach, makes before its first side effect.
 * Reads need no check, since every user may read every resource.
 */
export async function authorizeProject(principal: Actor, projectId: string): Promise<void> {
  if (principal.kind === 'system') return
  if (principal.userId !== await projectOwner(projectId)) {
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
