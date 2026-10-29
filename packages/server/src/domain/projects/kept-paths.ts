import { setProjectKeptIgnoredPaths } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { checkoutPathSchema } from './config'
import { assertProjectExists } from './detail'
import { authorizeProject, type Actor } from '#domain/access'

/*
 * The gitignored paths a project's stopped workspaces keep. A stop removes
 * every other ignored file from the checkout (docs/workspace-storage.md
 * "Ignored files at stop"). A project setting stored in the DB, like the
 * egress allowlist, so a client on another machine edits it through the API.
 */

/** More than any project needs, and few enough to pass on a command line. */
const MAX_KEPT_PATHS = 100

/** A literal path: the clean passes each to git as an escaped pattern, and
 *  a control character could not survive that or a NUL-separated list. */
const keptPathSchema = checkoutPathSchema
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'must not contain control characters')

/** Replace the project's kept paths, normalized and de-duplicated. Applies
 *  from the next stop. */
export async function setKeptIgnoredPaths(principal: Actor, projectId: string, paths: string[]): Promise<string[]> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  if (paths.length > MAX_KEPT_PATHS) throw new ServerError('VALIDATION', `at most ${MAX_KEPT_PATHS} kept paths`)
  const saved: string[] = []
  for (const raw of paths) {
    const parsed = keptPathSchema.safeParse(raw.trim())
    if (!parsed.success) throw new ServerError('VALIDATION', `"${raw}" ${parsed.error.issues[0].message}`)
    if (!saved.includes(parsed.data)) saved.push(parsed.data)
  }
  await setProjectKeptIgnoredPaths(projectId, saved)
  return saved
}
