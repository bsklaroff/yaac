import { ServerError } from '#errors'

/**
 * A project's display name for a repo path: its last segment, lowercased,
 * other characters replaced by `-`, cut to 63 characters and trimmed to
 * alphanumerics at both ends. '' if nothing is left; the server refuses
 * that. Shared so the webapp can show the name before the project exists.
 */
export function projectNameFor(repoPath: string): string {
  return (repoPath.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

/** The shortest id prefix accepted, so a short or hex-only name that
 *  names no project is not taken for another project's id. */
const MIN_ID_PREFIX = 8

/**
 * Resolve what a client typed for a project to the id of one of
 * `projects`: a full id, then a name, then a unique id prefix of at least
 * `MIN_ID_PREFIX` characters. Names are not unique, so a name several of
 * them share is an error listing them. Throws `NOT_FOUND` when nothing
 * matches. The server resolves among every project; the CLI among its
 * user's (docs/cli.md).
 */
export function resolveProjectRef(projects: Array<{ id: string; name: string }>, ref: string): string {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') throw new ServerError('VALIDATION', 'a project is required')
  if (projects.some((p) => p.id === wanted)) return wanted
  const named = projects.filter((p) => p.name === wanted)
  const matches = named.length > 0 || wanted.length < MIN_ID_PREFIX
    ? named
    : projects.filter((p) => p.id.startsWith(wanted))
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) throw new ServerError('NOT_FOUND', `project ${ref.trim()} not found`)
  throw new ServerError(
    'VALIDATION',
    `"${ref.trim()}" matches more than one project — use its id: `
    + matches.map((p) => `${p.name} (${p.id})`).join(', '),
  )
}
