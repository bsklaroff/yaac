import { createHash } from 'node:crypto'
import { constants as C, existsSync, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { repoDir, worktreeDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import type {
  SymlinkTarget,
  WorktreeDir,
  WorktreeFile,
  WorktreeFiles,
  WorktreeFileSaved,
} from '@yaac/shared/types'
import { listCheckoutFiles } from '#domain/git'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { MAX_TEXT_FILE_BYTES, isBinaryContent } from '#lib/text-file'
import { resolveWorktreeRecord } from './resolve'

/**
 * The webapp file editor's view of a worktree's checkout (docs/file-editor.md):
 * list, read, write, create, rename and delete, done with plain `fs` against
 * `worktreeDir` — the server's own mount of the checkout under k8s, the host
 * checkout itself under containerless — so a stopped worktree browses and
 * edits like a running one, and no driver is involved.
 *
 * Every path here is a SECURITY BOUNDARY under k8s: the checkout is the
 * sandboxed agent's to shape, and the server pod can see `server-local/`.
 * Symlinks are followed only as far as where they finally land, and that is
 * checked on what was actually opened — the descriptor — never on a path
 * string, which proves nothing about where the kernel ends up. All I/O then
 * goes through that descriptor, so there is no second lookup to race. A walk
 * that has to pin a directory opens each segment through its parent's
 * descriptor (`/proc/self/fd/<fd>/<name>`, Linux's stand-in for `openat`,
 * which Node lacks).
 *
 * Without `/proc/self/fd` (a macOS containerless server) there is no sandbox
 * to escape — the agent already runs as the host user — so the same checks
 * run on `fs.realpath` instead, where a race costs nothing the agent could
 * not do directly.
 */

/** The listing's cap on `paths`. */
const MAX_LISTED_PATHS = 50_000
/** The folder route's cap on entries. */
const MAX_DIR_ENTRIES = 5_000
/** How many untracked folders the empty-folder search may open. */
const MAX_EMPTY_DIR_VISITS = 5_000

const PROC_FD = existsSync('/proc/self/fd')

/** Mutations of one worktree's checkout run one at a time. */
const mutate = createKeyedMutex()

interface Checkout {
  worktreeId: string
  projectSlug: string
  dir: string
  /** `dir` with every symlink resolved — what a descriptor reads back as. */
  real: string
}

async function openCheckout(idOrName: string): Promise<Checkout> {
  const { projectSlug, worktreeId } = await resolveWorktreeRecord(idOrName)
  const dir = worktreeDir(projectSlug, worktreeId)
  try {
    return { worktreeId, projectSlug, dir, real: await fs.realpath(dir) }
  } catch {
    throw new ServerError('NOT_FOUND', `worktree ${idOrName} has no checkout`)
  }
}

/**
 * The lexical half of confinement: a non-empty relative path with no NUL,
 * no `..` once normalized, and not under `.git` (nothing in the listing
 * points there, and a write into it is how a hook or config gets planted).
 * Returns the normalized path.
 */
function checkPath(rel: string): string {
  if (rel === '' || rel.includes('\0') || path.posix.isAbsolute(rel)) {
    throw new ServerError('VALIDATION', `invalid path ${JSON.stringify(rel)}`)
  }
  const segments = path.posix.normalize(rel).replace(/\/+$/, '').split('/')
  if (segments.includes('..') || segments[0] === '.') {
    throw new ServerError('VALIDATION', `path escapes the worktree: ${JSON.stringify(rel)}`)
  }
  if (segments[0] === '.git') {
    throw new ServerError('VALIDATION', 'the .git folder is not editable')
  }
  return segments.join('/')
}

/** Where a real path sits in the checkout, or null when outside it (the
 *  checkout's `.git` counts as outside). */
function relativeTo(co: Checkout, real: string): string | null {
  // A pipe or socket reads back as `pipe:[123]`, which `path.relative` would
  // resolve against the process's cwd.
  if (!path.isAbsolute(real)) return null
  const rel = path.relative(co.real, real)
  if (rel === '') return rel
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep)
  return segments[0] === '.git' ? null : segments.join('/')
}

function outside(rel: string): ServerError {
  return new ServerError('VALIDATION', `${rel} points outside the worktree`)
}

/** Turn an fs failure into the answer a caller can act on. */
function fsFailure(err: unknown, rel: string): unknown {
  if (err instanceof ServerError) return err
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

/** Where an open descriptor really is. */
async function landed(fh: FileHandle): Promise<string> {
  return fs.readlink(`/proc/self/fd/${fh.fd}`)
}

/**
 * A directory pinned for the operations inside it: `child(name)` names an
 * entry relative to the pinned directory itself, so nothing swapped in above
 * it after the check can redirect the lookup.
 */
interface Dir {
  real: string
  self: string
  child(name: string): string
  close(): Promise<void>
}

function pinned(real: string, fh?: FileHandle): Dir {
  const self = fh ? `/proc/self/fd/${fh.fd}` : real
  return {
    real,
    self,
    child: (name) => `${self}/${name}`,
    close: async () => { await fh?.close() },
  }
}

/** Open a directory, following links, and verify it landed in the checkout. */
async function openDir(co: Checkout, abs: string, rel: string): Promise<Dir> {
  if (!PROC_FD) {
    const real = await fs.realpath(abs)
    if (relativeTo(co, real) === null) throw outside(rel)
    if (!(await fs.stat(real)).isDirectory()) throw new ServerError('VALIDATION', `${rel} is not a folder`)
    return pinned(real)
  }
  const fh = await fs.open(abs, C.O_RDONLY | C.O_DIRECTORY)
  const real = await landed(fh)
  if (relativeTo(co, real) === null) {
    await fh.close()
    throw outside(rel)
  }
  return pinned(real, fh)
}

/**
 * Open `name` inside `parent` only if it is a real directory right there —
 * never through a link. `O_NOFOLLOW` alone is not relied on (gVisor follows
 * a link anyway when `O_DIRECTORY` is also set), so where it landed is
 * checked too. Null for anything else: a file, a link, a vanished entry.
 */
async function openExactDir(parent: Dir, name: string): Promise<Dir | null> {
  const expected = path.join(parent.real, name)
  if (!PROC_FD) {
    const st = await fs.lstat(expected).catch(() => null)
    return st?.isDirectory() ? pinned(expected) : null
  }
  let fh: FileHandle
  try {
    fh = await fs.open(parent.child(name), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENOENT') return null
    throw err
  }
  if (await landed(fh) !== expected) {
    await fh.close()
    return null
  }
  return pinned(expected, fh)
}

/**
 * Pin the directory `rel` is in, one segment at a time from the checkout's
 * root, verifying each step before taking the next (and, with `create`,
 * making any segment that is missing). Returns it with the final name, which
 * the caller acts on through the pinned directory.
 */
async function openParent(
  co: Checkout,
  rel: string,
  opts: { create: boolean },
): Promise<{ dir: Dir; name: string }> {
  const segments = rel.split('/')
  const name = segments.pop()!
  let dir = await openDir(co, co.real, '.')
  try {
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      let next: Dir
      try {
        next = await openDir(co, dir.child(segment), walked)
      } catch (err) {
        if (!opts.create || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        await fs.mkdir(dir.child(segment)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e
        })
        next = await openDir(co, dir.child(segment), walked)
      }
      await dir.close()
      dir = next
    }
    return { dir, name }
  } catch (err) {
    await dir.close()
    throw fsFailure(err, rel)
  }
}

/** Open a file, following links, and verify it landed in the checkout. */
async function openFile(co: Checkout, rel: string, flags: number): Promise<FileHandle> {
  // Non-blocking so a planted FIFO cannot hang the open before it is checked.
  const safe = flags | C.O_NONBLOCK | C.O_NOCTTY
  const abs = path.join(co.real, rel)
  try {
    if (!PROC_FD) {
      const real = await fs.realpath(abs)
      if (relativeTo(co, real) === null) throw outside(rel)
      return await fs.open(real, safe)
    }
    const fh = await fs.open(abs, safe)
    if (relativeTo(co, await landed(fh)) === null) {
      await fh.close()
      throw outside(rel)
    }
    return fh
  } catch (err) {
    throw fsFailure(err, rel)
  }
}

async function regularFile(fh: FileHandle, rel: string): Promise<void> {
  const st = await fh.stat()
  if (st.isDirectory()) throw new ServerError('VALIDATION', `${rel} is a folder`)
  if (!st.isFile()) throw new ServerError('VALIDATION', `${rel} is not a regular file`)
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
    const target = relativeTo(co, real)
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
  const visit = async (dir: Dir, rel: string): Promise<void> => {
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
  const root = await openDir(co, co.real, '.')
  try {
    for (const top of untrackedDirs) {
      if (ignoredDirs.has(top) || top.split('/')[0] === '.git') continue
      // Pinned segment by segment: a root that is no longer a real folder
      // all the way down is simply skipped.
      let dir: Dir | null = root
      const opened: Dir[] = []
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
export async function listWorktreeFiles(idOrName: string): Promise<WorktreeFiles> {
  const co = await openCheckout(idOrName)
  const listing = await listCheckoutFiles(repoDir(co.projectSlug), co.worktreeId, co.dir)
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
      const abs = path.join(co.real, p)
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
 * The immediate children of one folder — how the explorer expands a folder
 * the listing leaves out (an ignored one, or a link into one). Everything
 * under an ignored folder is ignored, so a plain readdir is the right answer.
 */
export async function listWorktreeDir(idOrName: string, relPath: string): Promise<WorktreeDir> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(relPath)
  let dir: Dir
  try {
    dir = await openDir(co, path.join(co.real, rel), rel)
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
export async function readWorktreeFile(
  idOrName: string,
  relPath: string,
  known?: string,
): Promise<WorktreeFile> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(relPath)
  const fh = await openFile(co, rel, C.O_RDONLY)
  try {
    await regularFile(fh, rel)
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
export type WorktreeFileWrite = { saved: WorktreeFileSaved } | { conflict: string | null }

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
export async function writeWorktreeFile(
  idOrName: string,
  relPath: string,
  content: string,
  baseVersion: string | null,
): Promise<WorktreeFileWrite> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(relPath)
  const data = Buffer.from(content, 'utf8')
  if (data.length > MAX_TEXT_FILE_BYTES) {
    throw new ServerError('TOO_LARGE', `${rel} is over the ${MAX_TEXT_FILE_BYTES / 1024 ** 2} MiB editable size`)
  }
  const saved = { saved: { path: rel, version: hash(data), size: data.length } }
  return mutate(co.worktreeId, async () => {
    if (baseVersion === null) {
      const { dir, name } = await openParent(co, rel, { create: true })
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
      await regularFile(fh, rel)
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
    return (await readWorktreeFile(co.worktreeId, rel)).version
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      throw new ServerError('VALIDATION', `${rel} is a broken symlink`)
    }
    throw err
  }
}

/** Create a folder and any missing parents; a conflict if anything is
 *  already there. */
export async function createWorktreeFolder(idOrName: string, relPath: string): Promise<{ path: string }> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(relPath)
  return mutate(co.worktreeId, async () => {
    const { dir, name } = await openParent(co, rel, { create: true })
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
 * only something inside the worktree, within microseconds, could slip in
 * between.
 */
export async function renameWorktreeEntry(
  idOrName: string,
  fromPath: string,
  toPath: string,
): Promise<{ from: string; to: string }> {
  const co = await openCheckout(idOrName)
  const from = checkPath(fromPath)
  const to = checkPath(toPath)
  if (to.startsWith(`${from}/`)) throw new ServerError('VALIDATION', `can't move ${from} into itself`)
  return mutate(co.worktreeId, async () => {
    const src = await openParent(co, from, { create: false })
    try {
      await fs.lstat(src.dir.child(src.name)).catch((err: unknown) => { throw fsFailure(err, from) })
      const dst = await openParent(co, to, { create: true })
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
export async function deleteWorktreeEntry(idOrName: string, relPath: string): Promise<void> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(relPath)
  await mutate(co.worktreeId, async () => {
    const { dir, name } = await openParent(co, rel, { create: false })
    try {
      const st = await fs.lstat(dir.child(name))
      if (st.isDirectory()) await removeTree(dir, name)
      else await fs.unlink(dir.child(name))
    } catch (err) {
      throw fsFailure(err, rel)
    } finally {
      await dir.close()
    }
  })
}

/**
 * Remove a folder through descriptors: each child is opened as a real
 * folder through its parent's descriptor and recursed into, and anything
 * else — a file, or a link, which is never followed — is unlinked by name.
 * Node's own recursive `fs.rm` walks by path, so a folder swapped for a link
 * mid-walk could steer it out of the checkout; this walk never re-resolves
 * a path it has already checked.
 */
async function removeTree(parent: Dir, name: string): Promise<void> {
  if (!PROC_FD) {
    await fs.rm(parent.child(name), { recursive: true })
    return
  }
  const dir = await openExactDir(parent, name)
  if (!dir) {
    await fs.unlink(parent.child(name))
    return
  }
  try {
    for (const child of await fs.readdir(dir.self)) await removeTree(dir, child)
  } finally {
    await dir.close()
  }
  await fs.rmdir(parent.child(name))
}
