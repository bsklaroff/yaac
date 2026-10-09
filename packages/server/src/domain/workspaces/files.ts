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
  WorkspaceFileAtRev,
  WorkspaceFiles,
  WorkspaceFileSaved,
  BranchComparison,
  WorkspaceChanges,
} from '@yaac/shared/types'
import { workspaceDriver } from '#drivers/driver'
import {
  CHANGES_BASE_UNRESOLVED, CHANGES_BUSY, WorkspaceExecError, type ChangesReading,
} from '#drivers/contract'
import { lastFetchedAtMs } from '#domain/git'
import { authorizeProject, type Actor } from '#domain/access'
import {
  ConfinedPathError, openExactDir, openRoot, type ConfinedRoot, type PinnedDir,
} from '#lib/confined-fs'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { shellQuote } from '#lib/shell'
import { serverLog } from '#log'
import { MAX_TEXT_FILE_BYTES, isBinaryContent } from '#lib/text-file'
import { workspaceForkBranch } from './fork-branch'
import { checkoutBlobAt } from './checkout-git'
import { resolveWorkspaceContainer, resolveWorkspaceRecord } from './resolve'

/**
 * The webapp file editor's access to a workspace checkout
 * (docs/file-editor.md). Reads and writes use plain `fs` on the server's view
 * of the checkout, so they work for stopped workspaces too. The changes,
 * the ahead/behind count and the listing need the checkout's git, which
 * runs inside the workspace, so they require it to be running.
 *
 * The checkout is agent-controlled, so every access goes through a confined
 * root (`#lib/confined-fs`) that follows symlinks only while they stay
 * inside the checkout.
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
  projectId: string
  /** The workspace's runtime unit, when it has one. */
  jobName?: string
  dir: string
  /** The confined checkout. Its `.git` counts as outside, so the editor
   *  cannot plant a hook or config there. */
  root: ConfinedRoot
}

/** Open a workspace's checkout. A write passes its caller, who must own
 *  the workspace. */
async function openCheckout(idOrName: string, writer?: Actor): Promise<Checkout> {
  const { projectId, workspaceId, jobName } = await resolveWorkspaceRecord(idOrName)
  if (writer !== undefined) await authorizeProject(writer, projectId)
  const dir = workspaceDir(projectId, workspaceId)
  try {
    return { workspaceId, projectId, jobName, dir, root: await openRoot(dir, 'inside', { exclude: ['.git'] }) }
  } catch {
    throw new ServerError('NOT_FOUND', `workspace ${idOrName} has no checkout`)
  }
}

/**
 * The running workspace to run a git read in. `CONFLICT` if it exists but is
 * not running, `NOT_FOUND` if unknown.
 */
async function runningWorkspace(idOrName: string): Promise<{ jobName: string; projectId: string; workspaceId: string }> {
  const { jobName } = await resolveWorkspaceRecord(idOrName)
  if (jobName === undefined) throw new ServerError('CONFLICT', `workspace ${idOrName} is not running`)
  return resolveWorkspaceContainer(idOrName, { requireRunning: true })
}

/** `ConfinedRoot.normalize`, with a caller-facing error. */
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

async function writeAll(fh: FileHandle, data: Buffer): Promise<void> {
  let at = 0
  while (at < data.length) {
    at += (await fh.write(data, at, data.length - at, at)).bytesWritten
  }
}

/** Where a symlink leads, as the listing reports it. */
async function linkTarget(co: Checkout, rel: string): Promise<SymlinkTarget> {
  const to = await co.root.locate(rel)
  return to === null ? { target: null, dir: false } : { target: to.rel, dir: to.dir }
}

/**
 * Folders with no listed file, which git does not report. Walks each
 * untracked folder git collapsed (not following links, skipping ignored
 * folders) to find the folders inside it.
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
      if (ignoredDirs.has(top)) continue
      // Skip a root that is no longer a real folder all the way down.
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
 * Everything the webapp polls about a running workspace's checkout: the
 * diff against its base, how far HEAD is from the base branch, and, when
 * `listing` is asked for, every path for the explorer's tree.
 *
 * An explicit `base` wins; otherwise the default is the recorded fork
 * branch (`workspaceForkBranch`). Relying on `@{upstream}` instead would
 * show no changes once the agent pushes its branch, since the upstream then
 * points at HEAD. `diff: false` leaves the diff body out.
 *
 * The listing is left out when `known` is its current version, so a poll
 * whose tree has not moved costs no transfer. An unresolvable explicit
 * `base` becomes a VALIDATION error, and a run still busy from an earlier,
 * timed-out request RUNTIME_UNAVAILABLE. Other failures, including an
 * unresolvable recorded fork branch, stay faults.
 */
export async function getWorkspaceChanges(
  idOrName: string,
  base?: string,
  opts: { diff?: boolean; listing?: 'paths' | 'full'; known?: string } = {},
): Promise<WorkspaceChanges> {
  const { jobName, projectId, workspaceId } = await runningWorkspace(idOrName)
  const forkBranch = await workspaceForkBranch(projectId, workspaceId)
  // The runtime treats a blank `base` as unset.
  const named = base?.trim()
  let reading: ChangesReading
  try {
    reading = await workspaceDriver().changes(jobName, {
      base, defaultBase: forkBranch ?? undefined, diff: opts.diff ?? true, listing: opts.listing,
    })
  } catch (err) {
    if (named && err instanceof WorkspaceExecError && err.code === CHANGES_BASE_UNRESOLVED) {
      // The ref may exist but share no history with the workspace.
      throw new ServerError('VALIDATION', `base ref "${named}" gives no diff base in this workspace`)
    }
    if (err instanceof WorkspaceExecError && err.code === CHANGES_BUSY) {
      throw new ServerError('RUNTIME_UNAVAILABLE', 'still reading this checkout from an earlier request; try again shortly')
    }
    throw err
  }
  const { ref } = reading
  let comparison: BranchComparison | null = null
  if (ref) {
    comparison = { ref: ref.name, ahead: ref.ahead, behind: ref.behind }
    const fetchedAtMs = ref.name.startsWith('origin/')
      ? await lastFetchedAtMs(
        repoDir(projectId), ref.name.slice('origin/'.length), path.join(workspaceDir(projectId, workspaceId), '.git'),
      )
      : null
    if (fetchedAtMs !== null) comparison.fetchedAt = formatUtcTimestamp(fetchedAtMs)
  }
  const listing = reading.listing && await finishListing(await openCheckout(idOrName), reading.listing)
  return {
    ...reading.changes,
    branch: named || forkBranch || null,
    comparison,
    ...(listing && listing.version !== opts.known ? { listing } : {}),
  }
}

/** Whether `rel` is a path the file routes would accept as written. */
function isListable(co: Checkout, rel: string): boolean {
  try {
    return co.root.normalize(rel) === rel
  } catch {
    return false
  }
}

/**
 * The explorer's listing from what the script read: capped, with where each
 * symlink leads and, for a `full` listing, the folders holding no file.
 */
async function finishListing(co: Checkout, read: NonNullable<ChangesReading['listing']>): Promise<WorkspaceFiles> {
  // The script runs in the workspace, so every list may name anything. Only
  // paths the file routes accept are kept, before any is opened or resolved.
  const listable = (list: string[]): string[] => list.filter((p) => isListable(co, p.replace(/\/$/, '')))
  const listed = listable(read.paths)
  const listedIgnored = listable(read.ignored ?? [])
  // One cap for every list, so no checkout makes the answer unbounded.
  const truncated = listed.length > MAX_LISTED_PATHS || listedIgnored.length > MAX_LISTED_PATHS
  const paths = listed.slice(0, MAX_LISTED_PATHS)
  const ignored = listedIgnored.slice(0, MAX_LISTED_PATHS)
  // git records a link as one entry and never lists what is behind it.
  // Built in path order, so an unchanged listing hashes the same.
  const links = listable(read.links).slice(0, MAX_LISTED_PATHS)
  const targets = await Promise.all(links.map((p) => linkTarget(co, p)))
  const symlinks: Record<string, SymlinkTarget> = Object.fromEntries(links.map((p, i) => [p, targets[i]]))
  const body = {
    paths,
    symlinks,
    ignored,
    emptyDirs: read.untrackedDirs ? await findEmptyDirs(co, listable(read.untrackedDirs), paths, ignored) : [],
    conflicted: listable(read.conflicted),
    truncated,
  }
  return { version: hash(Buffer.from(JSON.stringify(body))), ...body }
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
        ? { name: e.name, dir: false, symlink: await linkTarget(co, `${rel}/${e.name}`) }
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

/**
 * One file's text at commit `rev` (the fork base the changes diff reports),
 * which the editor's diff modes compare the working copy against. Read with
 * the workspace's git, so it must be running.
 */
export async function readWorkspaceFileAtRev(
  idOrName: string,
  relPath: string,
  rev: string,
): Promise<WorkspaceFileAtRev> {
  // A full object id, so it can be neither an option nor a revision range.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev)) throw new ServerError('VALIDATION', `${rev} is not a commit id`)
  const { jobName } = await runningWorkspace(idOrName)
  const rel = checkPath(await openCheckout(idOrName), relPath)
  const blob = await checkoutBlobAt(jobName, rev, rel, MAX_TEXT_FILE_BYTES)
  if (blob === 'absent') return { exists: false, content: null }
  if (blob === 'large' || isBinaryContent(blob)) return { exists: true, content: null }
  return { exists: true, content: blob.toString('utf8') }
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
  principal: Actor,
  idOrName: string,
  relPath: string,
  content: string,
  baseVersion: string | null,
): Promise<WorkspaceFileWrite> {
  const co = await openCheckout(idOrName, principal)
  const rel = checkPath(co, relPath)
  const data = Buffer.from(content, 'utf8')
  if (data.length > MAX_TEXT_FILE_BYTES) {
    throw new ServerError('TOO_LARGE', `${rel} is over the ${MAX_TEXT_FILE_BYTES / 1024 ** 2} MiB editable size`)
  }
  const saved = { saved: { path: rel, version: hash(data), size: data.length } }
  const result = await mutate(co.workspaceId, async (): Promise<WorkspaceFileWrite> => {
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
    } finally {
      await fh.close()
    }
    return saved
  })
  // Outside the lock: a stuck workspace must not hold up the next edit.
  if (baseVersion !== null && 'saved' in result) await reopenInWorkspace(co, rel)
  return result
}

/**
 * Open a file the editor overwrote from inside its running pod. A pod
 * mounts its checkout with file attributes cached for up to a minute, so
 * its `git status` (the changes view, the agent's own) could miss the edit
 * until then; an open revalidates them (docs/nfs-checkout-performance.md).
 * A new, deleted or renamed file needs nothing: directories are cached for
 * a second. A host checkout caches nothing, so containerless skips it.
 *
 * The open reads nothing and gives up after a few seconds (a FIFO blocks
 * an open), and a failure is logged rather than retried.
 */
async function reopenInWorkspace(co: Checkout, rel: string): Promise<void> {
  const driver = workspaceDriver()
  if (co.jobName === undefined || driver.kind !== 'k8s') return
  const script = `cd ${shellQuote(driver.workspacePaths(co.jobName).workspaceDir)} && timeout 5 sh -c ': < "$1"' yaac "$1"`
  try {
    await driver.exec(co.jobName, `sh -c ${shellQuote(script)} yaac ${shellQuote(rel)}`, { maxAttempts: 1, timeout: 10_000 })
  } catch (err) {
    serverLog(`[files] ${co.workspaceId}: could not open ${rel} in the workspace after saving it, `
      + `so its git may not see the edit for up to a minute: ${err instanceof Error ? err.message : String(err)}`)
  }
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
export async function createWorkspaceFolder(
  principal: Actor,
  idOrName: string,
  relPath: string,
): Promise<{ path: string }> {
  const co = await openCheckout(idOrName, principal)
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
 * Move a file, folder or symlink (the link itself), creating missing parent
 * folders. A conflict if the destination exists (checked just before the
 * rename, so a narrow race remains).
 */
export async function renameWorkspaceEntry(
  principal: Actor,
  idOrName: string,
  fromPath: string,
  toPath: string,
): Promise<{ from: string; to: string }> {
  const co = await openCheckout(idOrName, principal)
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
export async function deleteWorkspaceEntry(principal: Actor, idOrName: string, relPath: string): Promise<void> {
  const co = await openCheckout(idOrName, principal)
  const rel = checkPath(co, relPath)
  await mutate(co.workspaceId, async () => {
    try {
      await co.root.removeTree(rel)
    } catch (err) {
      throw fsFailure(err, rel)
    }
  })
}
