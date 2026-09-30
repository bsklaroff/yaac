import { createHash } from 'node:crypto'
import { constants as C, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type {
  SymlinkTarget,
  WorkspaceDir,
  WorkspaceFile,
  WorkspaceFiles,
  WorkspaceFileSaved,
  WorkspaceGitStatus,
} from '@yaac/shared/types'
import { lastFetchedAtMs } from '#domain/git'
import {
  ConfinedPathError, openExactDir, openRoot, type ConfinedRoot, type PinnedDir,
} from '#lib/confined-fs'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { MAX_TEXT_FILE_BYTES, isBinaryContent } from '#lib/text-file'
import { workspaceForkBranch } from './fork-branch'
import { checkoutAheadBehind, listCheckoutFiles } from './checkout-git'
import { resolveWorkspaceContainer, resolveWorkspaceRecord } from './resolve'

/**
 * The webapp file editor's view of a workspace's checkout (docs/file-editor.md):
 * read, write, create, rename and delete, done with plain `fs` against
 * `workspaceDir` — the server's own mount of the checkout under k8s, the host
 * checkout itself under containerless — so a stopped workspace's files open
 * and save like a running one's, and no driver is involved. The listing and
 * the ahead/behind count are the exceptions: they need the checkout's git,
 * which runs inside the workspace, so they answer only while it runs.
 *
 * Every path here is a SECURITY BOUNDARY under k8s: the checkout is the
 * sandboxed agent's to shape, and the server pod can see `server-local/`.
 * So every access goes through the checkout's confined root
 * (`#lib/confined-fs`), which follows a symlink only as far as where it
 * finally lands inside the checkout, checked on the descriptor it opened.
 */

/** The listing's cap on `paths`. */
const MAX_LISTED_PATHS = 50_000
/** The folder route's cap on entries. */
const MAX_DIR_ENTRIES = 5_000
/** How many untracked folders the empty-folder search may open. */
const MAX_EMPTY_DIR_VISITS = 5_000

/** Mutations of one workspace's checkout run one at a time. */
const mutate = createKeyedMutex()

interface Checkout {
  workspaceId: string
  projectSlug: string
  dir: string
  /** The checkout, confined: links are followed only while they stay in
   *  it, and its `.git` counts as outside (nothing in the listing points
   *  there, and a write into it is how a hook or config gets planted). */
  root: ConfinedRoot
}

async function openCheckout(idOrName: string): Promise<Checkout> {
  const { projectSlug, workspaceId } = await resolveWorkspaceRecord(idOrName)
  const dir = workspaceDir(projectSlug, workspaceId)
  try {
    return { workspaceId, projectSlug, dir, root: await openRoot(dir, 'inside', { exclude: ['.git'] }) }
  } catch {
    throw new ServerError('NOT_FOUND', `workspace ${idOrName} has no checkout`)
  }
}

/**
 * The running workspace a git read has to happen in. A workspace that exists
 * but is not running is `CONFLICT` — "start it" — whether or not its
 * substrate still has a unit for it; only an unknown one is `NOT_FOUND`.
 */
async function runningWorkspace(idOrName: string): Promise<{ jobName: string; projectSlug: string; workspaceId: string }> {
  const { jobName } = await resolveWorkspaceRecord(idOrName)
  if (jobName === undefined) throw new ServerError('CONFLICT', `workspace ${idOrName} is not running`)
  return resolveWorkspaceContainer(idOrName, { requireRunning: true })
}

/** The lexical half of confinement (`ConfinedRoot.normalize`), as a
 *  caller's error. */
function checkPath(co: Checkout, rel: string): string {
  try {
    return co.root.normalize(rel)
  } catch (err) {
    throw fsFailure(err, rel)
  }
}

/** Turn an fs failure into the answer a caller can act on. */
function fsFailure(err: unknown, rel: string): unknown {
  if (err instanceof ServerError) return err
  if (err instanceof ConfinedPathError) {
    return new ServerError('VALIDATION', err.reason === 'outside' ? `${rel} points outside the workspace` : err.message)
  }
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
    case 'ENOTDIR': return new ServerError('NOT_FOUND', `no such file: ${rel}`)
    case 'EEXIST':
    case 'ENOTEMPTY': return new ServerError('CONFLICT', `${rel} already exists`)
    case 'EISDIR': return new ServerError('VALIDATION', `${rel} is a folder`)
    case 'ELOOP': return new ServerError('VALIDATION', `${rel} is a symlink loop`)
    case 'EINVAL': return new ServerError('VALIDATION', `can't move ${rel} into itself`)
    case 'EACCES':
    case 'EPERM': return new ServerError('VALIDATION', `permission denied: ${rel}`)
    default: return err
  }
}

/** Open a regular file, following links only as far as they stay inside. */
async function openFile(co: Checkout, rel: string, flags: number): Promise<FileHandle> {
  try {
    return await co.root.open(rel, flags)
  } catch (err) {
    throw fsFailure(err, rel)
  }
}

/** Pin the directory `rel` is in, as a caller's error. */
async function openParent(co: Checkout, rel: string, create: boolean): Promise<{ dir: PinnedDir; name: string }> {
  try {
    return await co.root.parent(rel, { create })
  } catch (err) {
    throw fsFailure(err, rel)
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A file too large to edit is never hashed; its version is its size and
 *  mtime, which is all a poll needs to notice it changed. */
function largeVersion(st: Stats): string {
  return `${st.size}:${st.mtimeMs}`
}

/**
 * A file's bytes, or null when there are more than the editable size. Read
 * into a fixed buffer rather than by the size `fstat` reported, which a file
 * growing under the read would make a promise the read does not keep.
 */
async function readEditable(fh: FileHandle): Promise<Buffer | null> {
  const buf = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1)
  let at = 0
  for (;;) {
    const { bytesRead } = await fh.read(buf, at, buf.length - at, at)
    if (bytesRead === 0) break
    at += bytesRead
    if (at === buf.length) return null
  }
  return buf.subarray(0, at)
}

async function writeAll(fh: FileHandle, data: Buffer): Promise<void> {
  let at = 0
  while (at < data.length) {
    at += (await fh.write(data, at, data.length - at, at)).bytesWritten
  }
}

/** Where a symlink leads, as the listing reports it. */
async function linkTarget(co: Checkout, abs: string): Promise<SymlinkTarget> {
  try {
    const real = await fs.realpath(abs)
    const target = co.root.contains(real)
    if (target === null) return { target: null, dir: false }
    return { target, dir: (await fs.stat(real)).isDirectory() }
  } catch {
    return { target: null, dir: false }
  }
}

/**
 * Every folder the explorer should show that holds no listed file: git
 * keeps no record of a folder, only of the untracked ones it collapses, so
 * each of those is walked — through pinned descriptors, never following a
 * link, skipping ignored folders — for the folders inside it.
 */
async function findEmptyDirs(
  co: Checkout,
  untrackedDirs: string[],
  paths: string[],
  ignored: string[],
): Promise<string[]> {
  const occupied = new Set<string>()
  for (const p of paths) {
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
      const dir = p.slice(0, i)
      if (occupied.has(dir)) break
      occupied.add(dir)
    }
  }
  const ignoredDirs = new Set(ignored.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)))
  const out: string[] = []
  let visits = 0
  const visit = async (dir: PinnedDir, rel: string): Promise<void> => {
    if (++visits > MAX_EMPTY_DIR_VISITS) return
    if (!occupied.has(rel)) out.push(rel)
    for (const entry of await fs.readdir(dir.self, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      // A nested repository's `.git` is git's own, not a folder to show.
      if (!entry.isDirectory() || entry.name === '.git' || ignoredDirs.has(child)) continue
      const sub = await openExactDir(dir, entry.name)
      if (!sub) continue
      try {
        await visit(sub, child)
      } finally {
        await sub.close()
      }
    }
  }
  const root = await co.root.dir('')
  try {
    for (const top of untrackedDirs) {
      if (ignoredDirs.has(top) || top.split('/')[0] === '.git') continue
      // Pinned segment by segment: a root that is no longer a real folder
      // all the way down is simply skipped.
      let dir: PinnedDir | null = root
      const opened: PinnedDir[] = []
      for (const segment of top.split('/')) {
        dir = await openExactDir(dir, segment)
        if (!dir) break
        opened.push(dir)
      }
      try {
        if (dir) await visit(dir, top)
      } finally {
        for (const d of opened) await d.close()
      }
    }
  } finally {
    await root.close()
  }
  return out
}

/**
 * Every path in the checkout, for the explorer's tree: gitignore-aware from
 * git, plus the ignored entries (collapsed per wholly ignored folder), the
 * folders holding no file, what each symlink leads to, and git status.
 */
export async function listWorkspaceFiles(idOrName: string): Promise<WorkspaceFiles> {
  const { jobName } = await runningWorkspace(idOrName)
  const co = await openCheckout(idOrName)
  const listing = await listCheckoutFiles(jobName)
  // One cap for every list the answer carries, so no checkout — however
  // many ignored or untracked files it holds — makes it unbounded.
  const truncated = listing.paths.length > MAX_LISTED_PATHS || listing.ignored.length > MAX_LISTED_PATHS
  const paths = listing.paths.slice(0, MAX_LISTED_PATHS)
  const ignored = listing.ignored.slice(0, MAX_LISTED_PATHS)
  const status = truncated
    ? Object.fromEntries(paths.filter((p) => p in listing.status).map((p) => [p, listing.status[p]]))
    : listing.status
  const symlinks: Record<string, SymlinkTarget> = {}
  // git reports a symlink as one entry and never lists what is behind one.
  for (let i = 0; i < paths.length; i += 256) {
    await Promise.all(paths.slice(i, i + 256).map(async (p) => {
      const abs = path.join(co.root.real, p)
      const st = await fs.lstat(abs).catch(() => null)
      if (st?.isSymbolicLink()) symlinks[p] = await linkTarget(co, abs)
    }))
  }
  return {
    paths,
    symlinks,
    ignored,
    emptyDirs: await findEmptyDirs(co, listing.untrackedDirs, paths, ignored),
    status,
    truncated,
  }
}

/**
 * How far the checkout's HEAD is ahead of and behind its reference branch:
 * `base` when the caller names one (the Changes pane's pick), else the branch
 * the workspace forked from — the same default the Changes diff takes.
 */
export async function getWorkspaceGitStatus(idOrName: string, base?: string): Promise<WorkspaceGitStatus> {
  const { jobName, projectSlug, workspaceId } = await runningWorkspace(idOrName)
  const branch = base?.trim() || await workspaceForkBranch(projectSlug, workspaceId)
  if (!branch) return { base: null, comparison: null }
  const found = await checkoutAheadBehind(jobName, branch)
  if (!found) return { base: branch, comparison: null }
  const { remote, ...comparison } = found
  const fetchedAtMs = remote
    ? await lastFetchedAtMs(repoDir(projectSlug), branch, path.join(workspaceDir(projectSlug, workspaceId), '.git'))
    : null
  return {
    base: branch,
    comparison: fetchedAtMs === null ? comparison : { ...comparison, fetchedAt: formatUtcTimestamp(fetchedAtMs) },
  }
}

/**
 * The immediate children of one folder — how the explorer expands a folder
 * the listing leaves out (an ignored one, or a link into one). Everything
 * under an ignored folder is ignored, so a plain readdir is the right answer.
 */
export async function listWorkspaceDir(idOrName: string, relPath: string): Promise<WorkspaceDir> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  let dir: PinnedDir
  try {
    dir = await co.root.dir(rel)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new ServerError('VALIDATION', `${rel} is not a folder`)
    }
    throw fsFailure(err, rel)
  }
  try {
    const all = await fs.readdir(dir.self, { withFileTypes: true })
    const entries = await Promise.all(all.slice(0, MAX_DIR_ENTRIES).map(async (e) => (
      e.isSymbolicLink()
        ? { name: e.name, dir: false, symlink: await linkTarget(co, dir.child(e.name)) }
        : { name: e.name, dir: e.isDirectory() }
    )))
    return { entries, truncated: all.length > MAX_DIR_ENTRIES }
  } finally {
    await dir.close()
  }
}

/**
 * Read one file. `content` is omitted when `known` is still the file's
 * version, and null when it is binary or over the editable size.
 */
export async function readWorkspaceFile(
  idOrName: string,
  relPath: string,
  known?: string,
): Promise<WorkspaceFile> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  const fh = await openFile(co, rel, C.O_RDONLY)
  try {
    const bytes = await readEditable(fh)
    if (bytes === null) {
      const st = await fh.stat()
      const head = Buffer.alloc(8192)
      const { bytesRead } = await fh.read(head, 0, head.length, 0)
      const binary = isBinaryContent(head.subarray(0, bytesRead), true)
      return { path: rel, version: largeVersion(st), size: st.size, binary, content: null }
    }
    const version = hash(bytes)
    const binary = isBinaryContent(bytes)
    const file = { path: rel, version, size: bytes.length, binary }
    if (known === version) return file
    return { ...file, content: binary ? null : bytes.toString('utf8') }
  } finally {
    await fh.close()
  }
}

/** A save either lands, or is refused naming the version the file has now
 *  (null: there is no file any more). */
export type WorkspaceFileWrite = { saved: WorkspaceFileSaved } | { conflict: string | null }

/**
 * Save one file against the version the editor last saw.
 *
 * A non-null `baseVersion` updates the file IN PLACE, through the descriptor
 * its version was checked on: that keeps its mode, inode, links and owner,
 * and saving through a symlink updates what it points to. It never creates:
 * a file that is gone is a conflict, which is what stops an autosave from
 * bringing back a file something else deleted. A null `baseVersion` creates,
 * making any missing parent folders, and conflicts with anything already
 * there.
 */
export async function writeWorkspaceFile(
  idOrName: string,
  relPath: string,
  content: string,
  baseVersion: string | null,
): Promise<WorkspaceFileWrite> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  const data = Buffer.from(content, 'utf8')
  if (data.length > MAX_TEXT_FILE_BYTES) {
    throw new ServerError('TOO_LARGE', `${rel} is over the ${MAX_TEXT_FILE_BYTES / 1024 ** 2} MiB editable size`)
  }
  const saved = { saved: { path: rel, version: hash(data), size: data.length } }
  return mutate(co.workspaceId, async () => {
    if (baseVersion === null) {
      const { dir, name } = await openParent(co, rel, true)
      let fh: FileHandle
      try {
        // O_EXCL never creates through a link, dangling or not.
        fh = await fs.open(dir.child(name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o666)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw fsFailure(err, rel)
        return { conflict: await existingVersion(co, rel) }
      } finally {
        await dir.close()
      }
      try {
        await writeAll(fh, data)
      } finally {
        await fh.close()
      }
      return saved
    }
    let fh: FileHandle
    try {
      fh = await openFile(co, rel, C.O_RDWR)
    } catch (err) {
      if (err instanceof ServerError && err.code === 'NOT_FOUND') return { conflict: null }
      throw err
    }
    try {
        const bytes = await readEditable(fh)
      const current = bytes === null ? largeVersion(await fh.stat()) : hash(bytes)
      if (current !== baseVersion) return { conflict: current }
      await fh.truncate(0)
      await writeAll(fh, data)
      return saved
    } finally {
      await fh.close()
    }
  })
}

/** The version of what a create found in its way. */
async function existingVersion(co: Checkout, rel: string): Promise<string> {
  try {
    return (await readWorkspaceFile(co.workspaceId, rel)).version
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      throw new ServerError('VALIDATION', `${rel} is a broken symlink`)
    }
    throw err
  }
}

/** Create a folder and any missing parents; a conflict if anything is
 *  already there. */
export async function createWorkspaceFolder(idOrName: string, relPath: string): Promise<{ path: string }> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  return mutate(co.workspaceId, async () => {
    const { dir, name } = await openParent(co, rel, true)
    try {
      await fs.mkdir(dir.child(name))
    } catch (err) {
      throw fsFailure(err, rel)
    } finally {
      await dir.close()
    }
    return { path: rel }
  })
}

/**
 * Move a file, folder or symlink (the link itself — `rename` never follows
 * its last segment), making the destination's missing parents. A conflict
 * if the destination exists: the check and the rename are two calls, so
 * only something inside the workspace, within microseconds, could slip in
 * between.
 */
export async function renameWorkspaceEntry(
  idOrName: string,
  fromPath: string,
  toPath: string,
): Promise<{ from: string; to: string }> {
  const co = await openCheckout(idOrName)
  const from = checkPath(co, fromPath)
  const to = checkPath(co, toPath)
  if (to.startsWith(`${from}/`)) throw new ServerError('VALIDATION', `can't move ${from} into itself`)
  return mutate(co.workspaceId, async () => {
    const src = await openParent(co, from, false)
    try {
      await fs.lstat(src.dir.child(src.name)).catch((err: unknown) => { throw fsFailure(err, from) })
      const dst = await openParent(co, to, true)
      try {
        const taken = await fs.lstat(dst.dir.child(dst.name)).then(() => true, () => false)
        if (taken) throw new ServerError('CONFLICT', `${to} already exists`)
        await fs.rename(src.dir.child(src.name), dst.dir.child(dst.name))
      } catch (err) {
        throw fsFailure(err, to)
      } finally {
        await dst.dir.close()
      }
    } finally {
      await src.dir.close()
    }
    return { from, to }
  })
}

/**
 * Delete a file, a symlink (the link, never what it points to) or a folder
 * with everything in it.
 */
export async function deleteWorkspaceEntry(idOrName: string, relPath: string): Promise<void> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  await mutate(co.workspaceId, async () => {
    try {
      await co.root.removeTree(rel)
    } catch (err) {
      throw fsFailure(err, rel)
    }
  })
}
