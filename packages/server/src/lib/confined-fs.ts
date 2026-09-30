import { randomBytes } from 'node:crypto'
import { constants as C, existsSync, type Dirent, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createKeyedMutex } from './keyed-mutex'

/**
 * Server file I/O under a directory that less-trusted code can write: a
 * workspace's checkout, and under a sandboxing runtime the tool homes and
 * conversation records a project's pods mount read-write
 * (docs/workspace-storage.md). A symlink planted there could steer a plain
 * `fs.readFile` at any file the server can read, and a FIFO could block a
 * libuv thread forever.
 *
 * Paths are checked on the opened descriptor, never on the path string. A
 * walk pins each directory and opens the next segment through it
 * (`/proc/self/fd/<fd>/<name>`, standing in for `openat`, which Node lacks),
 * so a swap above a checked directory cannot redirect it. Files open
 * non-blocking so a FIFO returns at once. Without `/proc/self/fd` (a macOS
 * containerless server) there is no sandbox, since the agent already runs
 * as the host user, so the same checks run on `fs.realpath`.
 *
 * Two link policies:
 *
 *  - `inside`: follow a link only if it lands inside the root. Checkouts
 *    contain links on purpose, and a containerless project dir holds yaac's
 *    per-workspace tool homes.
 *  - `no-links`: refuse any link below the root. Nothing legitimate writes
 *    links into a sandbox-mounted tool home, so one there was planted.
 */
export type LinkPolicy = 'inside' | 'no-links'

/** Serializes `ConfinedRoot.locked` per file, across every open root. */
const fileMutex = createKeyedMutex()

const PROC_FD = existsSync('/proc/self/fd')

/** Why a path was refused. Anything else a call throws is the fs error. */
export class ConfinedPathError extends Error {
  constructor(
    readonly rel: string,
    readonly reason: 'invalid' | 'outside' | 'not-a-file' | 'too-large',
    message: string,
    /** For `too-large`: the size the file had when it was refused. */
    readonly size?: number,
  ) {
    super(message)
    this.name = 'ConfinedPathError'
  }
}

/**
 * A directory pinned for the operations inside it: `child(name)` names an
 * entry relative to the pinned directory itself.
 */
export interface PinnedDir {
  /** Where the directory really is. */
  real: string
  /** A path that reaches exactly this directory, whatever changes above it. */
  self: string
  child(name: string): string
  close(): Promise<void>
}

export interface ConfinedRoot {
  /** The root with every link resolved. */
  real: string
  /** Where a real path sits under the root, or null outside it (or in an
   *  excluded top-level name). */
  contains(real: string): string | null
  /** The lexical half: a non-empty relative path with no NUL, no `..` once
   *  normalized, and not under an excluded name. Returns it normalized. */
  normalize(rel: string): string
  /** Pin a directory (`''` is the root), making missing segments with `create`. */
  dir(rel: string, opts?: { create?: boolean }): Promise<PinnedDir>
  /** Pin the directory `rel` is in, and say its final name. */
  parent(rel: string, opts?: { create?: boolean }): Promise<{ dir: PinnedDir; name: string }>
  /** Open a regular file. A directory is `EISDIR`; a FIFO, socket or device
   *  is refused without ever blocking. */
  open(rel: string, flags: number): Promise<FileHandle>
  /** A file's bytes, or null when there is no regular file there to read.
   *  More than `maxBytes` is refused (`too-large`) rather than cut short. */
  readFile(rel: string, opts: { maxBytes: number }): Promise<Buffer | null>
  /** A directory's entries, or [] when there is no directory there. */
  readdir(rel: string): Promise<Dirent[]>
  /** What is at `rel`, or null when nothing reachable is. */
  stat(rel: string): Promise<Stats | null>
  /** Replace a file through a fresh temp file in its pinned directory and a
   *  rename, making its directories: a link at `rel` is replaced, never
   *  written through. */
  writeAtomic(rel: string, data: string | Buffer): Promise<void>
  /**
   * Run `task` while no other `locked` call for the same file runs in this
   * process, whichever handle it came through. Wrap a read-modify-write of a
   * file several creates update at once (a project's shared tool config),
   * or one create's write silently drops another's.
   *
   * It only orders this process's own callers: a tool rewriting the file
   * itself, or another server or CLI process, does not take it. It is not
   * reentrant, so a task must not call `locked` on the same file again.
   */
  locked<T>(rel: string, task: () => Promise<T>): Promise<T>
  mkdirp(rel: string): Promise<void>
  /** Delete a file, a link (never its target) or a whole directory. */
  removeTree(rel: string): Promise<void>
}

function errno(code: string, rel: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${rel}`), { code })
}

function outside(rel: string): ConfinedPathError {
  return new ConfinedPathError(rel, 'outside', `${rel} points outside its root`)
}

/** An error meaning "nothing readable there", as opposed to a real failure. */
function unreadable(err: unknown): boolean {
  if (err instanceof ConfinedPathError) return err.reason !== 'too-large' && err.reason !== 'invalid'
  const code = (err as NodeJS.ErrnoException).code
  // ENXIO: a socket, which cannot be opened at all.
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP' || code === 'ENXIO'
}

async function landed(fh: FileHandle): Promise<string> {
  return fs.readlink(`/proc/self/fd/${fh.fd}`)
}

function pinned(real: string, fh?: FileHandle): PinnedDir {
  const self = fh ? `/proc/self/fd/${fh.fd}` : real
  return { real, self, child: (name) => `${self}/${name}`, close: async () => { await fh?.close() } }
}

/**
 * Open `name` inside `parent` only if it is a real directory right there —
 * never through a link. `O_NOFOLLOW` alone is not relied on (gVisor follows
 * a link anyway when `O_DIRECTORY` is also set), so where it landed is
 * checked too. Null for anything else: a file, a link, a vanished entry.
 */
export async function openExactDir(parent: PinnedDir, name: string): Promise<PinnedDir | null> {
  return exactDir(parent, name, name).catch(() => null)
}

async function exactDir(parent: PinnedDir, name: string, rel: string): Promise<PinnedDir> {
  const expected = path.join(parent.real, name)
  if (!PROC_FD) {
    const st = await fs.lstat(expected)
    if (st.isSymbolicLink()) throw outside(rel)
    if (!st.isDirectory()) throw errno('ENOTDIR', rel)
    return pinned(expected)
  }
  let fh: FileHandle
  try {
    fh = await fs.open(parent.child(name), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if ((code === 'ELOOP' || code === 'ENOTDIR')
      && (await fs.lstat(parent.child(name)).catch(() => null))?.isSymbolicLink()) throw outside(rel)
    throw err
  }
  if (await landed(fh) !== expected) {
    await fh.close()
    throw outside(rel)
  }
  return pinned(expected, fh)
}

/**
 * Open `root` for confined I/O. `exclude` names top-level entries treated as
 * outside it (a checkout's `.git`). `base`, a directory under the root,
 * is what relative paths are taken from — for a tree confined to a larger
 * one than the one it names paths in.
 */
export async function openRoot(
  root: string,
  policy: LinkPolicy,
  opts: { exclude?: string[]; base?: string } = {},
): Promise<ConfinedRoot> {
  const real = await fs.realpath(root)
  const exclude = new Set(opts.exclude)
  const base = opts.base === undefined ? [] : path.relative(root, opts.base).split(path.sep).filter(Boolean)

  const contains = (at: string): string | null => {
    // A pipe or socket reads back as `pipe:[123]`, which `path.relative`
    // would resolve against the process's cwd.
    if (!path.isAbsolute(at)) return null
    const rel = path.relative(real, at)
    if (rel === '') return rel
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
    const segments = rel.split(path.sep)
    return exclude.has(segments[0]) ? null : segments.join('/')
  }

  const normalize = (rel: string): string => {
    if (rel === '' || rel.includes('\0') || path.posix.isAbsolute(rel)) {
      throw new ConfinedPathError(rel, 'invalid', `invalid path ${JSON.stringify(rel)}`)
    }
    const segments = path.posix.normalize(rel).replace(/\/+$/, '').split('/')
    if (segments.includes('..') || segments[0] === '.') {
      throw new ConfinedPathError(rel, 'invalid', `path escapes its root: ${JSON.stringify(rel)}`)
    }
    if (exclude.has(segments[0])) {
      throw new ConfinedPathError(rel, 'invalid', `${segments[0]} is not reachable here`)
    }
    return segments.join('/')
  }

  /** Every segment from the root to `rel`. */
  const segmentsOf = (rel: string): string[] => [...base, ...(rel === '' ? [] : normalize(rel).split('/'))]

  /** Follow links from `abs`, and refuse where it lands unless it is a
   *  directory inside the root. */
  const followDir = async (abs: string, rel: string): Promise<PinnedDir> => {
    if (!PROC_FD) {
      const to = await fs.realpath(abs)
      if (contains(to) === null) throw outside(rel)
      if (!(await fs.stat(to)).isDirectory()) throw errno('ENOTDIR', rel)
      return pinned(to)
    }
    const fh = await fs.open(abs, C.O_RDONLY | C.O_DIRECTORY)
    const to = await landed(fh)
    if (contains(to) === null) {
      await fh.close()
      throw outside(rel)
    }
    return pinned(to, fh)
  }

  const step = (at: PinnedDir, name: string, rel: string): Promise<PinnedDir> =>
    policy === 'inside' ? followDir(at.child(name), rel) : exactDir(at, name, rel)

  const walk = async (segments: string[], create: boolean): Promise<PinnedDir> => {
    let at = await followDir(real, '.')
    try {
      for (let i = 0; i < segments.length; i++) {
        const name = segments[i]
        const rel = segments.slice(0, i + 1).join('/')
        let next: PinnedDir
        try {
          next = await step(at, name, rel)
        } catch (err) {
          if (!create || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          await fs.mkdir(at.child(name)).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e
          })
          next = await step(at, name, rel)
        }
        await at.close()
        at = next
      }
      return at
    } catch (err) {
      await at.close()
      throw err
    }
  }

  const parent = async (rel: string, opts: { create?: boolean } = {}): Promise<{ dir: PinnedDir; name: string }> => {
    const segments = segmentsOf(rel)
    const name = segments.pop()
    if (name === undefined) throw new ConfinedPathError(rel, 'invalid', 'the root has no parent')
    return { dir: await walk(segments, opts.create ?? false), name }
  }

  /** Open whatever is at `rel`, as the policy allows reaching it. */
  const openAny = async (rel: string, flags: number): Promise<FileHandle> => {
    // Non-blocking so a planted FIFO cannot hang the open before it is checked.
    const safe = flags | C.O_NONBLOCK | C.O_NOCTTY
    if (policy === 'inside') {
      const abs = path.join(real, ...segmentsOf(rel))
      if (!PROC_FD) {
        const to = await fs.realpath(abs)
        if (contains(to) === null) throw outside(rel)
        return fs.open(to, safe)
      }
      const fh = await fs.open(abs, safe)
      if (contains(await landed(fh)) === null) {
        await fh.close()
        throw outside(rel)
      }
      return fh
    }
    const { dir, name } = await parent(rel)
    try {
      const expected = path.join(dir.real, name)
      if (!PROC_FD && (await fs.lstat(expected)).isSymbolicLink()) throw outside(rel)
      let fh: FileHandle
      try {
        fh = await fs.open(dir.child(name), safe | C.O_NOFOLLOW)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw outside(rel)
        throw err
      }
      if (PROC_FD && await landed(fh) !== expected) {
        await fh.close()
        throw outside(rel)
      }
      return fh
    } finally {
      await dir.close()
    }
  }

  const open = async (rel: string, flags: number): Promise<FileHandle> => {
    const fh = await openAny(rel, flags)
    try {
      const st = await fh.stat()
      if (st.isDirectory()) throw errno('EISDIR', rel)
      if (!st.isFile()) throw new ConfinedPathError(rel, 'not-a-file', `${rel} is not a regular file`)
      return fh
    } catch (err) {
      await fh.close()
      throw err
    }
  }

  const removeAt = async (at: PinnedDir, name: string): Promise<void> => {
    if (!PROC_FD) {
      await fs.rm(at.child(name), { recursive: true })
      return
    }
    // Open each child directory through its parent's descriptor and recurse;
    // unlink anything else (files, and links, which are never followed).
    // Node's recursive `fs.rm` walks by path, so a directory swapped for a
    // link mid-walk could lead it out of the root.
    const sub = await openExactDir(at, name)
    if (!sub) {
      await fs.unlink(at.child(name))
      return
    }
    try {
      for (const child of await fs.readdir(sub.self)) await removeAt(sub, child)
    } finally {
      await sub.close()
    }
    await fs.rmdir(at.child(name))
  }

  return {
    real,
    contains,
    normalize,
    dir: (rel, opts = {}) => walk(segmentsOf(rel), opts.create ?? false),
    locked: (rel, task) => fileMutex(path.join(real, ...segmentsOf(rel)), task),
    parent,
    open,

    async readFile(rel, { maxBytes }) {
      let fh: FileHandle
      try {
        fh = await open(rel, C.O_RDONLY)
      } catch (err) {
        if (unreadable(err)) return null
        throw err
      }
      try {
        // Read to EOF rather than trusting `fstat`'s size, which a growing
        // file would outrun; reading one byte past the cap detects too-large.
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
          const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1 - total))
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, total)
          if (bytesRead === 0) return Buffer.concat(chunks, total)
          chunks.push(chunk.subarray(0, bytesRead))
          total += bytesRead
          if (total > maxBytes) {
            const { size } = await fh.stat()
            throw new ConfinedPathError(rel, 'too-large', `${rel} is over ${String(maxBytes)} bytes`, size)
          }
        }
      } finally {
        await fh.close()
      }
    },

    async readdir(rel) {
      let at: PinnedDir
      try {
        at = await walk(segmentsOf(rel), false)
      } catch (err) {
        if (unreadable(err)) return []
        throw err
      }
      try {
        return await fs.readdir(at.self, { withFileTypes: true })
      } finally {
        await at.close()
      }
    },

    async stat(rel) {
      const fh = await openAny(rel, C.O_RDONLY).catch(() => null)
      if (fh === null) return null
      try {
        return await fh.stat()
      } finally {
        await fh.close()
      }
    },

    async writeAtomic(rel, data) {
      const { dir, name } = await parent(rel, { create: true })
      try {
        // O_EXCL never creates through a link. The name is random so another
        // writer in the directory cannot pre-occupy the names we would pick.
        let tmp = ''
        let fh: FileHandle | undefined
        for (let tries = 0; fh === undefined; tries++) {
          tmp = `.${name}.${randomBytes(8).toString('hex')}.tmp`
          fh = await fs.open(dir.child(tmp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o666)
            .catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'EEXIST' || tries >= 3) throw err
              return undefined
            })
        }
        try {
          try {
            await fh.writeFile(data)
          } finally {
            await fh.close()
          }
          await fs.rename(dir.child(tmp), dir.child(name))
        } catch (err) {
          await fs.rm(dir.child(tmp), { force: true }).catch(() => {})
          throw err
        }
      } finally {
        await dir.close()
      }
    },

    async mkdirp(rel) {
      await (await walk(segmentsOf(rel), true)).close()
    },

    async removeTree(rel) {
      const { dir, name } = await parent(rel)
      try {
        await removeAt(dir, name)
      } finally {
        await dir.close()
      }
    },
  }
}
