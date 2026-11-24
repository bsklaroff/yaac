/**
 * One-shot import of the build dirs an older server kept
 * (docs/legacy-compat-shims.md "Build dirs"): a project's
 * `config/build/Dockerfile.yaac` with its support files becomes its image
 * `default` at revision 1, set as the project default, and a user's
 * `server-local/users/<id>/build/Dockerfile.user` becomes their user image.
 * The image, its revision and the default are written in one transaction,
 * and only then is the dir renamed to `build.imported`, which marks it done
 * and keeps whatever the import did not store. A dir whose import fails
 * stays, and the next start tries again.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, serverLocalPath } from '@yaac/shared/project-paths'
import type { ImageFileManifest } from '@yaac/shared/types'
import {
  insertImageWithRevision,
  listImages,
  listProjectRows,
  type ImageScope,
} from '#db'
import { collectContextFiles, parseContainerIgnore } from '#lib/build-context'
import { serverLog } from '#lib/log'
import { putBlob, revisionContentHash } from './blobs'

async function readDockerfile(file: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8')
    return text.trim() === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Store a build dir's support files (what its build sent) as blobs. */
async function importFiles(scope: ImageScope, dir: string, dockerfileName: string): Promise<ImageFileManifest> {
  let ignore = new Set<string>()
  try {
    ignore = parseContainerIgnore(await fs.readFile(path.join(dir, '.containerignore'), 'utf8'))
  } catch { /* none */ }
  const files: ImageFileManifest = {}
  for (const rel of await collectContextFiles(dir, '', ignore)) {
    if (rel === dockerfileName) continue
    files[rel] = await putBlob(scope, await fs.readFile(path.join(dir, rel)))
  }
  return files
}

/**
 * Import one build dir as image `name`, and rename it to `build.imported`.
 * True when it imported one; an image of that name already there means an
 * earlier start imported it and died before the rename.
 */
async function importDir(
  scope: ImageScope,
  dir: string,
  dockerfileName: string,
  name: string,
  author: string,
): Promise<boolean> {
  const dockerfile = await readDockerfile(path.join(dir, dockerfileName))
  if (dockerfile === undefined) return false
  const imported = (await listImages(scope)).some((i) => i.name === name)
  if (!imported) {
    const files = await importFiles(scope, dir, dockerfileName)
    await insertImageWithRevision(scope, name, {
      dockerfile, files, contentHash: revisionContentHash(dockerfile, files), author, note: `imported from ${dockerfileName}`,
    }, { makeDefault: true })
  }
  await fs.rename(dir, await freeName(`${dir}.imported`))
  return !imported
}

/** `base`, or `base.2`, `base.3`… if taken, so a rename never replaces. */
async function freeName(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}.${String(n)}`
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}

/** Import every project's and user's build dir; a failure is logged per dir. */
export async function importLegacyBuildDirs(): Promise<void> {
  for (const project of await listProjectRows()) {
    try {
      if (await importDir(
        { projectId: project.id }, path.join(projectConfigDir(project.id), 'build'), 'Dockerfile.yaac', 'default', project.owner,
      )) serverLog(`[images] imported ${project.id}'s Dockerfile.yaac as its default image`)
    } catch (err) {
      serverLog(`[images] could not import ${project.id}'s Dockerfile.yaac: ${String(err)}`)
    }
  }
  let users: string[] = []
  try {
    users = await fs.readdir(serverLocalPath('users'))
  } catch { /* no user dirs */ }
  for (const userId of users) {
    try {
      const dir = serverLocalPath('users', userId, 'build')
      if (await importDir({ userId }, dir, 'Dockerfile.user', 'Dockerfile.user', userId)) {
        serverLog(`[images] imported user ${userId}'s Dockerfile.user`)
      }
    } catch (err) {
      serverLog(`[images] could not import user ${userId}'s Dockerfile.user: ${String(err)}`)
    }
  }
}
