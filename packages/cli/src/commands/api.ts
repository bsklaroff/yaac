import { getApiClient } from '@yaac/shared/server-api'

/**
 * The API client every command uses. The server target resolves on the first
 * request, so importing this module reads no files.
 */
export const api = getApiClient()

/** Project names by id, for listings that show which project a row is in. */
export async function projectNames(): Promise<Map<string, string>> {
  return new Map((await api.project.list.$get()).map((p) => [p.id, p.name]))
}

/**
 * The id of the project a user named (a name, id or id prefix, resolved by
 * the server), for a command that makes several calls about it: a name
 * resolved on each call could land on different projects in between.
 */
export async function resolveProjectId(project: string): Promise<string> {
  return (await api.project[':projectId'].$get({ param: { projectId: project } })).id
}
