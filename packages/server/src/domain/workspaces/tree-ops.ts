import { createHash, randomBytes } from 'node:crypto'
import { constants as C, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { mediaType } from '@yaac/shared/media-types'
import type { SymlinkTarget, WorkspaceDir, WorkspaceFile, WorkspaceFileSaved } from '@yaac/shared/types'
import { ConfinedPathError, openExactDir, openRoot, type ConfinedRoot, type PinnedDir } from '#lib/confined-fs'
import { MAX_TEXT_FILE_BYTES, isBinaryContent } from '#lib/text-file'

/**
 * What the file editor does to a workspace's files, as operations on one
 * directory tree (docs/file-editor.md). Every path is relative to the tree's
 * root and goes through a confined root (`#lib/confined-fs`), which follows
 * links only while they stay inside it and treats each checkout's `.git` as
 * outside.
 *
 * The same code runs in two places: in the server, on its own view of the
 * workspace dir, and inside a running k8s workspace as the `yaac-files`
 * helper (`tree-helper.ts`), on the workspace's view of it. Arguments and
 * answers are therefore plain JSON, bytes as base64, and the failures a
 * caller can act on are `ServerError`s, which the helper carries back as
 * code and message.
 */

/** The folder route's cap on entries. */
const MAX_DIR_ENTRIES = 5_000
/** The listing's cap on `paths`. */
export const MAX_LISTED_PATHS = 50_000
/** How many folders the walks for empty and outside folders may open. */
const MAX_EMPTY_DIR_VISITS = 5_000

/** A save either lands, or is refused naming the version the file has now
 *  (null: there is no file any more). */
export type WorkspaceFileWrite = { saved: WorkspaceFileSaved } | { conflict: string | null }

/** Every operation, by name, with its JSON arguments and answer. */
export interface TreeOps {
  /** The immediate children of one folder, capped. */
  dir(a: { rel: string }): Promise<WorkspaceDir>
  /** One file, its content omitted while `known` is its version. */
  read(a: { rel: string; known?: string }): Promise<WorkspaceFile>
  /** A media file's size, refusing any file that is not media. */
  mediaSize(a: { rel: string }): Promise<number>
  /** Up to `length` bytes of a file from `start`, as base64. */
  range(a: { rel: string; start: number; length: number }): Promise<string>
  /** Save a file against the version the editor saw (`writeFile`). */
  write(a: { rel: string; data: string; baseVersion: string | null }): Promise<WorkspaceFileWrite>
  /** Make a new empty file, and any missing folders; a conflict if taken. */
  create(a: { rel: string }): Promise<void>
  /** Make a fresh staging file beside `rel`, returning its path. */
  stage(a: { rel: string }): Promise<string>
  /** Write base64 `data` into an existing file at `offset`. */
  append(a: { rel: string; offset: number; data: string }): Promise<void>
  /** Put the staging file `from`'s bytes at `rel`, whole, then remove it. */
  replace(a: { rel: string; from: string }): Promise<void>
  /** Make a folder and its missing parents; a conflict if taken. */
  mkdir(a: { rel: string }): Promise<void>
  /** Move an entry, making missing folders; a conflict if `to` is taken. */
  rename(a: { from: string; to: string }): Promise<void>
  /** Delete a file, a link (never its target) or a folder, recursively. */
  remove(a: { rel: string }): Promise<void>
  /** Every file outside the checkouts at `checkouts` (`walkOutside`). */
  walkOutside(a: { checkouts: string[] }): Promise<OutsideWalk>
  /** Folders holding no listed path (`findEmptyDirs`). */
  emptyDirs(a: { untrackedDirs: string[]; paths: string[]; ignored: string[] }): Promise<string[]>
  /** Where each symlink leads, as the listing reports it. */
  locate(a: { rels: string[] }): Promise<SymlinkTarget[]>
}

export type TreeOp = keyof TreeOps
export type TreeArgs<K extends TreeOp> = Parameters<TreeOps[K]>[0]
export type TreeResult<K extends TreeOp> = Awaited<ReturnType<TreeOps[K]>>

/** One operation on the tree at `root`, a path as whoever runs it sees it. */
export interface TreeRequest<K extends TreeOp = TreeOp> {
  root: string
  /** Entries treated as outside the tree: each checkout's `.git`. */
  exclude: string[]
  op: K
  args: TreeArgs<K>
  /** A file to touch once the operation has changed something: the tree
   *  container's trigger, which asks it for a checkpoint pass. */
  trigger?: string
}

export interface OutsideWalk { paths: string[]; links: string[]; dirs: string[]; truncated: boolean }

/** The tree's root could not be opened: the workspace has no checkout. */
export class NoTreeError extends Error {}

/** Run one operation, opening the tree for it. */
export async function runTreeRequest<K extends TreeOp>(req: TreeRequest<K>): Promise<TreeResult<K>> {
  let root: ConfinedRoot
  try {
    root = await openRoot(req.root, 'inside', { exclude: req.exclude })
  } catch {
    throw new NoTreeError(req.root)
  }
  const op = treeOps(root)[req.op] as (a: TreeArgs<K>) => Promise<TreeResult<K>>
  if (typeof op !== 'function') throw new Error(`unknown file operation ${String(req.op)}`)
  const result = await op(req.args)
  if (req.trigger !== undefined) {
    const now = new Date()
    await fs.utimes(req.trigger, now, now).catch(() => fs.writeFile(req.trigger as string, '')).catch(() => {})
  }
  return result
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
    case 'ENAMETOOLONG': return new ServerError('VALIDATION', `${rel}: name too long`)
    case 'EINVAL': return new ServerError('VALIDATION', `can't move ${rel} into itself`)
    case 'EACCES':
    case 'EPERM': return new ServerError('VALIDATION', `permission denied: ${rel}`)
    default: return err
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A file too large to edit is not hashed; its version is size and mtime. */
function largeVersion(st: Stats): string {
  return `${st.size}:${st.mtimeMs}`
}

/**
 * A file's bytes, or null if over the editable size. Reads into a fixed
 * buffer, since the file may grow after `fstat`.
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

/** Write all of `data` at file offset `start`. */
async function writeAll(fh: FileHandle, data: Uint8Array, start = 0): Promise<void> {
  let at = 0
  while (at < data.length) {
    at += (await fh.write(data, at, data.length - at, start + at)).bytesWritten
  }
}

/** The operations on the tree `root` opens. */
export function treeOps(root: ConfinedRoot): TreeOps {
  const checkPath = (rel: string): string => {
    try {
      return root.normalize(rel)
    } catch (err) {
      throw fsFailure(err, rel)
    }
  }
  const openFile = async (rel: string, flags: number): Promise<FileHandle> => {
    try {
      return await root.open(rel, flags)
    } catch (err) {
      throw fsFailure(err, rel)
    }
  }
  const openParent = async (rel: string, create: boolean): Promise<{ dir: PinnedDir; name: string }> => {
    try {
      return await root.parent(rel, { create })
    } catch (err) {
      throw fsFailure(err, rel)
    }
  }
  /** O_EXCL never creates through a link, dangling or not. */
  const createIn = (dir: PinnedDir, name: string): Promise<FileHandle> =>
    fs.open(dir.child(name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o666)
  const linkTarget = async (rel: string): Promise<SymlinkTarget> => {
    const to = await root.locate(rel)
    return to === null ? { target: null, dir: false } : { target: to.rel, dir: to.dir }
  }

  /**
   * Replace the regular file `rel` leads to (following links while they
   * stay inside) with what `fill` writes, through a temp file beside it, a
   * sync and a rename, so a reader sees the old bytes or the new ones and a
   * failed write leaves the old file. The new file takes `was`'s mode and,
   * where this process may give it, its owner; a hard link to the old file
   * keeps the old bytes.
   */
  const swapIn = async (rel: string, was: Stats, fill: (fh: FileHandle) => Promise<void>): Promise<void> => {
    const target = await root.locate(rel)
    if (target === null || target.dir) throw new ServerError('NOT_FOUND', `no such file: ${rel}`)
    const { dir, name } = await openParent(target.rel, false)
    const tmp = `.${name}.yaac-save-${randomBytes(6).toString('hex')}`
    try {
      const fh = await createIn(dir, tmp)
      try {
        await fill(fh)
        await fh.chmod(was.mode & 0o7777)
        await fh.chown(was.uid, was.gid).catch(() => {})
        await fh.datasync()
      } finally {
        await fh.close()
      }
      await fs.rename(dir.child(tmp), dir.child(name))
    } catch (err) {
      await fs.unlink(dir.child(tmp)).catch(() => {})
      throw fsFailure(err, rel)
    } finally {
      await dir.close()
    }
  }

  const read: TreeOps['read'] = async ({ rel: relPath, known }) => {
    const rel = checkPath(relPath)
    const fh = await openFile(rel, C.O_RDONLY)
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

  /** The version of what a create found in its way. */
  const existingVersion = async (rel: string): Promise<string> => {
    try {
      return (await read({ rel })).version
    } catch (err) {
      if (err instanceof ServerError && err.code === 'NOT_FOUND') {
        throw new ServerError('VALIDATION', `${rel} is a broken symlink`)
      }
      throw err
    }
  }

  return {
    async dir({ rel: relPath }) {
      const rel = checkPath(relPath)
      let dir: PinnedDir
      try {
        dir = await root.dir(rel)
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
            ? { name: e.name, dir: false, symlink: await linkTarget(`${rel}/${e.name}`) }
            : { name: e.name, dir: e.isDirectory() }
        )))
        return { entries, truncated: all.length > MAX_DIR_ENTRIES }
      } finally {
        await dir.close()
      }
    },

    read,

    async mediaSize({ rel: relPath }) {
      const rel = checkPath(relPath)
      if (mediaType(rel) === null) throw new ServerError('VALIDATION', `${rel} is not an image, video, audio or PDF file`)
      const fh = await openFile(rel, C.O_RDONLY)
      try {
        return (await fh.stat()).size
      } finally {
        await fh.close()
      }
    },

    async range({ rel: relPath, start, length }) {
      const rel = checkPath(relPath)
      const fh = await openFile(rel, C.O_RDONLY)
      try {
        const buf = Buffer.alloc(length)
        let at = 0
        while (at < length) {
          const { bytesRead } = await fh.read(buf, at, length - at, start + at)
          if (bytesRead === 0) break
          at += bytesRead
        }
        return buf.subarray(0, at).toString('base64')
      } finally {
        await fh.close()
      }
    },

    /**
     * A non-null `baseVersion` replaces the file the path leads to whole
     * (`swapIn`), once the bytes there are still that version. It never
     * creates: a file that is gone is a conflict, which is what stops an
     * autosave from bringing back a file something else deleted. A null
     * `baseVersion` creates, making any missing parent folders, and
     * conflicts with anything already there.
     */
    async write({ rel: relPath, data: b64, baseVersion }) {
      const rel = checkPath(relPath)
      const data = Buffer.from(b64, 'base64')
      const saved = { saved: { path: rel, version: hash(data), size: data.length } }
      if (baseVersion === null) {
        const { dir, name } = await openParent(rel, true)
        let fh: FileHandle
        try {
          fh = await createIn(dir, name)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw fsFailure(err, rel)
          return { conflict: await existingVersion(rel) }
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
        fh = await openFile(rel, C.O_RDONLY)
      } catch (err) {
        if (err instanceof ServerError && err.code === 'NOT_FOUND') return { conflict: null }
        throw err
      }
      let st: Stats
      try {
        st = await fh.stat()
        const bytes = await readEditable(fh)
        const current = bytes === null ? largeVersion(st) : hash(bytes)
        if (current !== baseVersion) return { conflict: current }
      } finally {
        await fh.close()
      }
      await swapIn(rel, st, (out) => writeAll(out, data))
      return saved
    },

    async create({ rel: relPath }) {
      const rel = checkPath(relPath)
      const { dir, name } = await openParent(rel, true)
      try {
        await (await createIn(dir, name)).close()
      } catch (err) {
        throw fsFailure(err, rel)
      } finally {
        await dir.close()
      }
    },

    /**
     * A staging file is named at random beside its target, so a replacement
     * can be taken in full before the target is touched. It is an ordinary
     * file of the workspace until `replace` removes it.
     */
    async stage({ rel: relPath }) {
      const rel = checkPath(relPath)
      const { dir } = await openParent(rel, true)
      const name = `.yaac-upload-${randomBytes(8).toString('hex')}`
      try {
        await (await createIn(dir, name)).close()
      } catch (err) {
        throw fsFailure(err, rel)
      } finally {
        await dir.close()
      }
      return path.posix.join(path.posix.dirname(rel), name)
    },

    async append({ rel: relPath, offset, data }) {
      const rel = checkPath(relPath)
      const fh = await openFile(rel, C.O_WRONLY)
      try {
        await writeAll(fh, Buffer.from(data, 'base64'), offset)
      } finally {
        await fh.close()
      }
    },

    /**
     * An existing file is replaced whole, as a save replaces it (`swapIn`).
     * A missing one is linked into place from the staging file, which
     * conflicts with anything that appeared there meanwhile.
     */
    async replace({ rel: relPath, from: fromPath }) {
      const rel = checkPath(relPath)
      const from = checkPath(fromPath)
      const staged = await openFile(from, C.O_RDONLY)
      try {
        let existing: Stats | null = null
        try {
          const fh = await openFile(rel, C.O_RDONLY)
          try {
            existing = await fh.stat()
          } finally {
            await fh.close()
          }
        } catch (err) {
          if (!(err instanceof ServerError && err.code === 'NOT_FOUND')) throw err
        }
        if (existing !== null) {
          await swapIn(rel, existing, async (out) => {
            const buf = Buffer.alloc(1 << 20)
            for (let at = 0; ;) {
              const { bytesRead } = await staged.read(buf, 0, buf.length, at)
              if (bytesRead === 0) break
              await writeAll(out, buf.subarray(0, bytesRead), at)
              at += bytesRead
            }
          })
        } else {
          const { dir, name } = await openParent(rel, true)
          try {
            await fs.link(dir.child(path.posix.basename(from)), dir.child(name))
          } catch (err) {
            throw fsFailure(err, rel)
          } finally {
            await dir.close()
          }
        }
      } finally {
        await staged.close()
      }
      await root.removeTree(from).catch(() => {})
    },

    async mkdir({ rel: relPath }) {
      const rel = checkPath(relPath)
      const { dir, name } = await openParent(rel, true)
      try {
        await fs.mkdir(dir.child(name))
      } catch (err) {
        throw fsFailure(err, rel)
      } finally {
        await dir.close()
      }
    },

    /** The destination is checked just before the rename, so a narrow race
     *  remains. */
    async rename({ from: fromPath, to: toPath }) {
      const from = checkPath(fromPath)
      const to = checkPath(toPath)
      if (to.startsWith(`${from}/`)) throw new ServerError('VALIDATION', `can't move ${from} into itself`)
      const src = await openParent(from, false)
      try {
        await fs.lstat(src.dir.child(src.name)).catch((err: unknown) => { throw fsFailure(err, from) })
        const dst = await openParent(to, true)
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
    },

    async remove({ rel: relPath }) {
      const rel = checkPath(relPath)
      try {
        await root.removeTree(rel)
      } catch (err) {
        throw fsFailure(err, rel)
      }
    },

    /**
     * Links are listed and not followed, and a `.git` is git's own, not a
     * folder to show. Also reports the top-level folders holding files, and
     * stops at the listing's caps.
     */
    async walkOutside({ checkouts }) {
      const skip = new Set(checkouts)
      const out: OutsideWalk = { paths: [], links: [], dirs: [], truncated: false }
      let visits = 0
      const visit = async (dir: PinnedDir, rel: string): Promise<void> => {
        for (const entry of await fs.readdir(dir.self, { withFileTypes: true })) {
          const child = rel === '' ? entry.name : `${rel}/${entry.name}`
          if (entry.name === '.git' || (rel === '' && skip.has(entry.name))) continue
          if (!entry.isDirectory()) {
            if (out.paths.length >= MAX_LISTED_PATHS) out.truncated = true
            else out.paths.push(child)
            if (entry.isSymbolicLink()) out.links.push(child)
            continue
          }
          if (rel === '') out.dirs.push(child)
          if (++visits > MAX_EMPTY_DIR_VISITS) {
            out.truncated = true
            continue
          }
          const sub = await openExactDir(dir, entry.name)
          if (!sub) continue
          try {
            await visit(sub, child)
          } finally {
            await sub.close()
          }
        }
      }
      const top = await root.dir('')
      try {
        await visit(top, '')
      } finally {
        await top.close()
      }
      return out
    },

    /**
     * Folders with no listed file, which git does not report. Walks each
     * untracked folder git collapsed (not following links, skipping ignored
     * folders) to find the folders inside it.
     */
    async emptyDirs({ untrackedDirs, paths, ignored }) {
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
      const top = await root.dir('')
      try {
        for (const start of untrackedDirs) {
          if (ignoredDirs.has(start)) continue
          // Skip a root that is no longer a real folder all the way down.
          let dir: PinnedDir | null = top
          const opened: PinnedDir[] = []
          for (const segment of start.split('/')) {
            dir = await openExactDir(dir, segment)
            if (!dir) break
            opened.push(dir)
          }
          try {
            if (dir) await visit(dir, start)
          } finally {
            for (const d of opened) await d.close()
          }
        }
      } finally {
        await top.close()
      }
      return out
    },

    locate: ({ rels }) => Promise.all(rels.map(linkTarget)),
  }
}
