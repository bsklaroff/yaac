import { getProjectRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { isRankedPermissionMode, morePermissive, type PermissionMode, type Principal } from '@yaac/shared/types'

/**
 * How much of a resource a caller asks for (docs/multi-user.md
 * "Authorization"): `reader` is any user; `delegate` is the resource's
 * owner or a delegate of theirs, for the verbs an agent may call; `owner`
 * is the owner in person, and covers every other write plus the attaches
 * that grant execution.
 */
export type AccessLevel = 'reader' | 'delegate' | 'owner'

/**
 * Who a domain verb acts for: a request's principal (a person, or a
 * delegate acting for one), or the server itself (`systemPrincipal`).
 */
export type Actor = Principal | { kind: 'system' }

/**
 * The server acting on its own, for a gated verb it calls with no request
 * behind it (a queued workspace's launch). `identify()` never returns it,
 * so no request can claim it.
 */
export const systemPrincipal: Actor = { kind: 'system' }

/**
 * Whether `actor` is a person, as opposed to the server or a delegate. Only
 * a person approves a privileged launch (docs/workflows.md "Approvals") or
 * changes what a site exposes.
 */
export function isPerson(actor: Actor): actor is Extract<Actor, { kind: 'local' | 'tailnet' }> {
  return actor.kind === 'local' || actor.kind === 'tailnet'
}

/** Who refused a verb is asked of, for a refusal's wording. */
function notPerson(actor: Actor): string {
  return actor.kind === 'delegate' ? `, not ${actor.via.label}` : ''
}

/** Refuse with FORBIDDEN unless a person asks, naming what only a person
 *  may do. */
export function requirePerson(actor: Actor, what: string): void {
  if (!isPerson(actor)) throw new ServerError('FORBIDDEN', `only a person may ${what}${notPerson(actor)}`)
}

/**
 * The user id of a person, for what is theirs alone: their sign-ins,
 * credentials, settings and shortcuts, the projects they add, their seen
 * marks. A delegate has no account of its own, so it is refused rather
 * than handed its user's; so is the server. The only way code outside this
 * folder reads a caller's user id (enforced by eslint).
 */
export function personId(actor: Actor): string {
  // eslint-disable-next-line no-restricted-syntax -- answers only a person's own id
  if (isPerson(actor)) return actor.userId
  throw new ServerError('FORBIDDEN', actor.kind === 'delegate'
    ? `${actor.via.label} has no account of its own: what is its user's alone is theirs to read or change`
    : 'only a person has an account')
}

/**
 * Refuse with FORBIDDEN a delegate asking for something that would run in
 * a more permissive mode than its ceiling (docs/permission-modes.md "A
 * spawned workspace's posture"): `what` names it, as the subject of the
 * refusal. A person and the server pass. A mode this build does not rank
 * cannot be compared, so it is refused.
 */
export function requireWithinCeiling(actor: Actor, mode: PermissionMode, what: string): void {
  if (actor.kind !== 'delegate') return
  const { ceiling, via } = actor
  if (isRankedPermissionMode(mode) && isRankedPermissionMode(ceiling) && !morePermissive(mode, ceiling)) return
  throw new ServerError('FORBIDDEN', isRankedPermissionMode(mode) && isRankedPermissionMode(ceiling)
    ? `${what}: permission mode '${mode}' is more permissive than ${via.label}'s ceiling ('${ceiling}')`
    : `${what}: cannot tell whether permission mode '${mode}' is within ${via.label}'s ceiling ('${ceiling}')`)
}

/**
 * Who `actor` is in the request log and audit lines: `server`, a person's
 * login (`local` for a local install's one user), or `<login> via <what>`
 * for a delegate.
 */
export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'system': return 'server'
    case 'local': return 'local'
    case 'tailnet': return actor.login
    case 'delegate': return `${actor.login ?? 'local'} via ${actor.via.label}`
  }
}

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
 *  some verbs authorize before they check the project exists, and a held
 *  project (`withProjectsHeld`) is CONFLICT. */
async function projectOwner(projectId: string): Promise<string> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const held = holds.get(projectId)
  if (held !== undefined) throw new ServerError('CONFLICT', held)
  return row.owner
}

/**
 * Refuse with FORBIDDEN unless `actor` may act on the project at `level`
 * (docs/multi-user.md "Authorization"): the check every user-caused write,
 * and every attach, makes before its first side effect. `owner` admits the
 * project's owner in person; `delegate` also admits a delegate of theirs
 * whose project, if it has one, is this one; `reader` admits anyone but a
 * delegate scoped to another project. The server passes every level.
 */
export async function authorizeProject(actor: Actor, projectId: string, level: AccessLevel = 'owner'): Promise<void> {
  const owner = await projectOwner(projectId)
  if (actor.kind === 'system') return
  if (actor.kind === 'delegate') {
    if (actor.projectId !== undefined && actor.projectId !== projectId) {
      throw new ServerError('FORBIDDEN', `${actor.via.label} may read and act only in its own project`)
    }
    if (level === 'reader') return
    if (level === 'owner') throw new ServerError('FORBIDDEN', `only the owner of this project may do that, in person${notPerson(actor)}`)
  } else if (level === 'reader') return
  // eslint-disable-next-line no-restricted-syntax -- compared with the owner of a project looked up here, and answers nothing
  if (actor.userId !== owner) throw new ServerError('FORBIDDEN', 'only the owner of this project may do that')
}
