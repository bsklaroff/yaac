/**
 * Image file content (docs/image-builds.md "Images, revisions and
 * builds"): support files live in a content-addressed store per scope, a
 * revision's manifest names them by hash, and a build materializes a
 * revision into a fresh context dir.
 * Paths in a manifest pass `validateFilePath`, the one traversal guard.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { globalProjectPath, serverLocalPath } from '@yaac/shared/project-paths'
import type { ImageFileManifest } from '@yaac/shared/types'
import { BUILDER_CONTEXT_MAX_BYTES, MAX_IMAGE_FILE_BYTES } from '#lib/build-context'
import type { ImageScope } from '#db'

/** How long an upload no revision names yet is kept: the webapp uploads a
 *  file the moment it is added, and saves the revision later. */
const UNSAVED_BLOB_GRACE_MS = 24 * 60 * 60_000

/** A scope's blob dir: the project's global tree, or the user's server-local one. */
function blobDir(scope: ImageScope): string {
  return 'projectId' in scope
    ? globalProjectPath(scope.projectId, 'image-blobs')
    : serverLocalPath('users', scope.userId, 'image-blobs')
}

function blobPath(scope: ImageScope, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ServerError('VALIDATION', `not a file hash: ${sha256}`)
  return path.join(blobDir(scope), sha256)
}

/**
 * A context-relative file path, normalized. Rejects absolute paths, `..`,
 * backslashes and NULs, so no manifest entry can name a file outside the
 * context it is materialized into.
 */
export function validateFilePath(rel: string): string {
  if (rel.trim() !== rel || rel.length === 0 || rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel)) {
    throw new ServerError('VALIDATION', `invalid file path ${JSON.stringify(rel)}`)
  }
  const normalized = path.posix.normalize(rel).replace(/\/+$/, '')
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ServerError('VALIDATION', `file path escapes the build context: ${JSON.stringify(rel)}`)
  }
  return normalized
}

/** Store `data` in the scope's blob store; idempotent per content. */
export async function putBlob(scope: ImageScope, data: Buffer): Promise<{ sha256: string; size: number }> {
  if (data.length > MAX_IMAGE_FILE_BYTES) {
    throw new ServerError('VALIDATION', `a file may be at most ${MAX_IMAGE_FILE_BYTES / 1024 ** 2}MB`)
  }
  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  const target = blobPath(scope, sha256)
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    // Uploaded again: it starts a new grace (`pruneBlobs`).
    const now = new Date()
    await fs.utimes(target, now, now)
  } catch {
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, target)
  }
  return { sha256, size: data.length }
}

/** One stored file's bytes, or undefined once collected. */
export async function readBlob(scope: ImageScope, sha256: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(blobPath(scope, sha256))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Manifest paths whose bytes are no longer stored. */
export async function missingFiles(scope: ImageScope, files: ImageFileManifest): Promise<string[]> {
  const missing: string[] = []
  for (const [rel, { sha256 }] of Object.entries(files)) {
    try {
      await fs.access(blobPath(scope, sha256))
    } catch {
      missing.push(rel)
    }
  }
  return missing.sort()
}

/**
 * Check a manifest before it becomes a revision: valid paths, none both a
 * file and a folder, every blob present, and the context, by the stored
 * sizes, under the builder's cap. The sizes it returns are the stored ones.
 */
export async function validateManifest(scope: ImageScope, files: ImageFileManifest): Promise<ImageFileManifest> {
  const out: ImageFileManifest = {}
  for (const [rel, entry] of Object.entries(files)) out[validateFilePath(rel)] = { sha256: entry.sha256, size: entry.size }
  const paths = Object.keys(out)
  const clash = paths.find((p) => paths.some((q) => q.startsWith(`${p}/`)))
  if (clash !== undefined) throw new ServerError('VALIDATION', `${clash} is both a file and a folder`)
  const missing: string[] = []
  let total = 0
  for (const [rel, entry] of Object.entries(out)) {
    try {
      entry.size = (await fs.stat(blobPath(scope, entry.sha256))).size
      total += entry.size
    } catch {
      missing.push(rel)
    }
  }
  if (missing.length > 0) throw new ServerError('VALIDATION', `upload these files first: ${missing.sort().join(', ')}`)
  if (total > BUILDER_CONTEXT_MAX_BYTES) {
    throw new ServerError('VALIDATION', `the files total ${Math.round(total / 1024 ** 2)}MB; a build context may be at most ${BUILDER_CONTEXT_MAX_BYTES / 1024 ** 2}MB`)
  }
  return out
}

/**
 * A revision's content hash, from its Dockerfile and manifest alone, so
 * resolving a chain reads no file. Saving identical content is a no-op
 * because two such revisions hash alike.
 */
export function revisionContentHash(dockerfile: string, files: ImageFileManifest): string {
  const h = crypto.createHash('sha256').update(dockerfile).update('\0')
  for (const rel of Object.keys(files).sort()) h.update(rel).update('\0').update(files[rel].sha256).update('\0')
  return h.digest('hex').slice(0, 16)
}

/**
 * Write a revision's files into `dir` (created fresh), group-writable so a
 * `COPY` keeps them usable at any uid (docs/arbitrary-uid-images.md).
 */
export async function materializeFiles(scope: ImageScope, files: ImageFileManifest, dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true, mode: 0o775 })
  for (const [rel, { sha256 }] of Object.entries(files)) {
    const data = await readBlob(scope, sha256)
    if (data === undefined) throw new ServerError('CONFLICT', `the bytes of ${rel} are no longer kept; save the file again`)
    const target = path.join(dir, validateFilePath(rel))
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o775 })
    await fs.writeFile(target, data, { mode: 0o664 })
    await fs.chmod(target, 0o664)
  }
}

/** Delete every blob of the scope that `keep` does not name and that is
 *  older than an unsaved upload's grace. */
export async function pruneBlobs(scope: ImageScope, keep: ReadonlySet<string>): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(blobDir(scope))
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name) || keep.has(name)) continue
    const file = path.join(blobDir(scope), name)
    const { mtimeMs } = await fs.stat(file)
    if (mtimeMs > Date.now() - UNSAVED_BLOB_GRACE_MS) continue
    await fs.rm(file, { force: true })
    removed++
  }
  return removed
}
