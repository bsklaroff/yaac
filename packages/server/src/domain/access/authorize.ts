import { BUILT_IN_USER_ID, getProjectRow } from '#db'
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
 *  some verbs authorize before they check the project exists. A share its
 *  source's owner removed is FORBIDDEN to everyone, the server included. */
async function projectOwner(projectId: string): Promise<string> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (row.shareRevoked) throw new ServerError('FORBIDDEN', `${row.name} is no longer shared with its owner`)
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
 * Refuse with FORBIDDEN unless `principal` is a person acting as the
 * install's owner (the built-in user, docs/remote-hosting.md "Access
 * modes"): the check for settings that spend the install's own authority
 * rather than one user's. A workspace acting for its owner is refused too.
 */
export function authorizeInstallOwner(principal: Actor): void {
  if (principal.kind === 'local' || principal.kind === 'tailnet') {
    if (principal.userId === BUILT_IN_USER_ID) return
  }
  throw new ServerError('FORBIDDEN', 'only the owner of this install may do that')
}

/**
 * The actor a workspace's yaac-mama call runs as: the calling workspace,
 * acting as its project's owner.
 */
export async function workspacePrincipal(workspaceId: string, projectId: string): Promise<Actor> {
  return { kind: 'workspace', workspaceId, userId: await projectOwner(projectId) }
}
