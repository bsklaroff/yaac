import { getProjectRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { Principal } from '@yaac/shared/types'

/**
 * How much of a resource a caller asks for (docs/plans/multi-user-deployment.md
 * "Authorization"). `reader` is any user; `owner` is the resource's owner
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
 * Something a caller may own, by its owner's user id. A workspace, queued
 * workspace, draft or group is owned by its project's owner.
 */
export interface Owned {
  ownerId: string
}

/**
 * The server acting on its own, for a gated verb it calls with no request
 * behind it (a queued workspace's launch). `identify()` never returns it,
 * so no request can claim it.
 */
export const systemPrincipal: Actor = { kind: 'system' }

/** Refuse with FORBIDDEN unless `principal` may act on `resource` at `level`. */
export function authorize(principal: Actor, level: AccessLevel, resource: Owned): void {
  if (level === 'reader' || principal.kind === 'system' || principal.userId === resource.ownerId) return
  throw new ServerError('FORBIDDEN', 'only the owner of this project may do that')
}

/** A project's owner. A project that does not exist is `NOT_FOUND`, since
 *  some verbs authorize before they check the project exists. */
async function projectOwner(projectId: string): Promise<string> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return row.owner
}

/**
 * `authorize` at `owner` on a project, and so on anything in it: the check
 * every user-caused write makes before its first side effect.
 */
export async function authorizeProject(principal: Actor, projectId: string): Promise<void> {
  if (principal.kind === 'system') return
  authorize(principal, 'owner', { ownerId: await projectOwner(projectId) })
}

/**
 * The actor a workspace's yaac-mama call runs as: the calling workspace,
 * acting as its project's owner.
 */
export async function workspacePrincipal(workspaceId: string, projectId: string): Promise<Actor> {
  return { kind: 'workspace', workspaceId, userId: await projectOwner(projectId) }
}
