import fs from 'node:fs/promises'
import path from 'node:path'
import { collectContextFiles } from '#lib/container/image-builder'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/container/builder-pod'
import { PROJECT_DOCKERFILE, USER_DOCKERFILE } from '#lib/project/build-dirs'
import { ServerError } from '@yaac/shared/errors'

/**
 * User-managed support files inside a build dir (`resolveProjectBuildDir` /
 * `resolveUserBuildDir`) — the files a Dockerfile can COPY. Everything here
 * operates on paths relative to one build dir root and goes through
 * `resolveBuildFilePath`, the single traversal guard. Only regular files are
 * ever created, so no symlink can smuggle an out-of-tree read into the
 * context hash or the builder-pod tar (whose collector skips symlinks too).
 */

/** Files readable/writable inline as text; larger ones upload as base64. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/** Per-file upload cap — a sanity bound well under the whole-context cap. */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024

/** The Dockerfiles are managed by their dedicated, validated editors. */
const RESERVED_NAMES = new Set<string>([PROJECT_DOCKERFILE, USER_DOCKERFILE])

export interface BuildFileEntry {
  /** Context-relative path, `/`-separated. */
  path: string
  size: number
  binary: boolean
}

/**
 * Validate a context-relative path and resolve it under `root`. The only
 * path derivation in this module: rejects absolute paths, `..` traversal,
 * backslashes/NULs, and the root-level Dockerfile names (those stay behind
 * their validated editors, so e.g. the layered check on Dockerfile.user
 * can't be sidestepped here). Returns the absolute path.
 */
export function resolveBuildFilePath(root: string, rel: string): string {
  if (rel.trim() !== rel || rel.length === 0) {
    throw new ServerError('VALIDATION', 'invalid path')
  }
  if (rel.includes('\\') || rel.includes('\0')) {
    throw new ServerError('VALIDATION', `invalid path ${JSON.stringify(rel)}`)
  }
  if (path.isAbsolute(rel)) {
    throw new ServerError('VALIDATION', `path must be relative: ${JSON.stringify(rel)}`)
  }
  const normalized = path.normalize(rel).replace(/\/+$/, '')
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ServerError('VALIDATION', `path escapes the build folder: ${JSON.stringify(rel)}`)
  }
  if (RESERVED_NAMES.has(normalized)) {
    throw new ServerError('VALIDATION', `${normalized} is managed by the Dockerfile editor`)
  }
  return path.join(root, normalized)
}

/** NUL byte in the first 8KB — the standard "not a text file" sniff. */
async function isBinaryFile(abs: string): Promise<boolean> {
  const fh = await fs.open(abs, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fh.close()
  }
}

/**
 * List every support file in the build dir (recursive, sorted), hiding the
 * root Dockerfile. Uses the same collector as `contextHash` and the
 * builder-pod streamer, so the listing is exactly what the build will see.
 */
export async function listBuildFiles(root: string): Promise<BuildFileEntry[]> {
  let files: string[]
  try {
    files = await collectContextFiles(root, '', new Set())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries: BuildFileEntry[] = []
  for (const rel of files.sort()) {
    if (RESERVED_NAMES.has(rel)) continue
    const abs = path.join(root, rel)
    const stat = await fs.stat(abs)
    entries.push({ path: rel, size: stat.size, binary: await isBinaryFile(abs) })
  }
  return entries
}

export interface BuildFileContent extends BuildFileEntry {
  /** UTF-8 text for editable files; null when binary or over the text cap. */
  content: string | null
}

/** Read one file. `content` is null for binary or over-cap files. */
export async function readBuildFile(root: string, rel: string): Promise<BuildFileContent> {
  const abs = resolveBuildFilePath(root, rel)
  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new ServerError('NOT_FOUND', `no build file at ${rel}`)
  }
  if (!stat.isFile()) {
    throw new ServerError('VALIDATION', `${rel} is a folder`)
  }
  const binary = await isBinaryFile(abs)
  const editable = !binary && stat.size <= MAX_TEXT_FILE_BYTES
  return {
    path: rel,
    size: stat.size,
    binary,
    content: editable ? await fs.readFile(abs, 'utf8') : null,
  }
}

/**
 * Write (or create) one regular file, creating parent folders as needed.
 * Enforces the per-file cap and the whole-context cap (mirroring
 * `BUILDER_CONTEXT_MAX_BYTES`, so a folder that a build would reject can't
 * be assembled in the first place).
 */
export async function writeBuildFile(root: string, rel: string, data: Buffer): Promise<BuildFileEntry> {
  const abs = resolveBuildFilePath(root, rel)
  if (data.length > MAX_UPLOAD_FILE_BYTES) {
    throw new ServerError(
      'VALIDATION',
      `file exceeds the ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 ** 2)}MB per-file limit`,
    )
  }
  const existing = await listBuildFiles(root)
  const otherBytes = existing
    .filter((f) => f.path !== path.relative(root, abs))
    .reduce((sum, f) => sum + f.size, 0)
  if (otherBytes + data.length > BUILDER_CONTEXT_MAX_BYTES) {
    throw new ServerError(
      'VALIDATION',
      `build folder would exceed the ${Math.round(BUILDER_CONTEXT_MAX_BYTES / 1024 ** 2)}MB context limit`,
    )
  }
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, data)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A path segment crossing an existing file (ENOTDIR/EEXIST) or a write
    // onto an existing folder (EISDIR) is a caller mistake, not a crash.
    if (code === 'ENOTDIR' || code === 'EEXIST' || code === 'EISDIR') {
      throw new ServerError('VALIDATION', `path conflicts with an existing entry: ${rel}`)
    }
    throw err
  }
  return { path: path.relative(root, abs), size: data.length, binary: data.includes(0) }
}

/** Delete one file or folder (recursive). */
export async function deleteBuildFile(root: string, rel: string): Promise<void> {
  const abs = resolveBuildFilePath(root, rel)
  try {
    await fs.access(abs)
  } catch {
    throw new ServerError('NOT_FOUND', `no build file at ${rel}`)
  }
  await fs.rm(abs, { recursive: true, force: true })
}
