import { getApiClient } from '@yaac/shared/server-api'
import { ServerError } from '@yaac/shared/errors'
import { resolveProjectRef } from '@yaac/shared/project-name'
import type { ProjectSummary, User } from '@yaac/shared/types'

/**
 * The API client every command uses. The server target resolves on the first
 * request, so importing this module reads no files.
 */
export const api = getApiClient()

/** The global `--user`, set before any command runs; unset means the
 *  caller. */
let userRef: string | undefined

export function scopeToUser(ref: string | undefined): void {
  userRef = ref
}

/** The projects a command means (docs/cli.md "Whose projects"). */
export interface ProjectScope {
  /** The user in scope: `--user`'s, else the caller's. */
  userId: string
  /** That user's projects. */
  projects: ProjectSummary[]
  /** Every user's projects. */
  all: ProjectSummary[]
}

/**
 * Whose projects names and listings mean: the caller's, or those of the
 * user `--user` names by id, login or display name.
 */
export async function projectScope(): Promise<ProjectScope> {
  const [whoami, all] = await Promise.all([api.whoami.$get(), api.project.list.$get()])
  const userId = userRef === undefined ? whoami.userId : findUser(whoami.users, userRef)
  return { userId, projects: all.filter((p) => p.owner === userId), all }
}

function findUser(users: User[], ref: string): string {
  const wanted = ref.trim().toLowerCase()
  const matches = users.filter((u) => u.id === wanted || u.login?.toLowerCase() === wanted || u.name.toLowerCase() === wanted)
  if (matches.length === 1) return matches[0].id
  const listed = (us: User[]): string => us.map((u) => u.login ?? u.name).join(', ')
  throw new Error(matches.length === 0
    ? `No user "${ref}" on this server; its users are ${listed(users)}.`
    : `"${ref}" names more than one user — use a login: ${listed(matches)}.`)
}

/**
 * The id of the project a user named. A full id names anyone's project; a
 * name or id prefix names one of the projects in scope (`projectScope`).
 * Commands resolve once and send the id, since a name resolved on each
 * call could land on different projects in between. `scope` saves a
 * command that already has one the lookup.
 */
export async function resolveProjectId(project: string, scope?: ProjectScope): Promise<string> {
  const { projects, all } = scope ?? await projectScope()
  const id = project.trim().toLowerCase()
  if (all.some((p) => p.id === id)) return id
  try {
    return resolveProjectRef(projects, project)
  } catch (err) {
    if (!(err instanceof ServerError) || err.code !== 'NOT_FOUND') throw err
    throw new Error(userRef === undefined
      ? `You have no project ${project.trim()}; pass --user <user> for a teammate's.`
      : `${userRef} has no project ${project.trim()}.`)
  }
}
