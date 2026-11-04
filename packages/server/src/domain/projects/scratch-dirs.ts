/**
 * A project's scratch dirs: checkout-relative dirs of installed packages
 * and build output that live with a workspace's runtime rather than its
 * checkout (docs/workspace-storage.md "Package installs"), and the ones git
 * tracks that the user asked not to be warned about.
 */
import { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'
import type { ScratchDirSettings } from '@yaac/shared/types'
import { setProjectScratchDirs } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { checkoutPathSchema } from './config'
import { assertProjectExists } from './detail'

/** A list of paths, deduplicated. */
const scratchDirPathsSchema = z.array(checkoutPathSchema, { error: 'must be a string array' })
  .transform((paths) => [...new Set(paths)])

/** A change to a project's scratch-dir settings: either part, or both. A
 *  path listed twice keeps its first entry. */
export const scratchDirSettingsPatchSchema = z.object({
  dirs: z.array(z.object({
    path: checkoutPathSchema,
    sizeGiB: z.number({ error: 'must be a whole number of GiB' }).int().min(1).max(1024).optional(),
  }), { error: 'must be an array of {path, sizeGiB?} objects' })
    .transform((dirs) => dirs.filter((d, i) => dirs.findIndex((e) => e.path === d.path) === i))
    .optional(),
  ignoredTracked: scratchDirPathsSchema.optional(),
})

/** Replace either part, one left out keeping its value, and answer the
 *  settings as stored. */
export async function setScratchDirs(
  principal: Actor,
  projectId: string,
  set: Partial<ScratchDirSettings>,
): Promise<ScratchDirSettings> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  const stored = await setProjectScratchDirs(projectId, set)
  if (!stored) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return stored
}
