import { createHash } from 'node:crypto'
import path from 'node:path'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { ServerError, type ErrorCode } from '@yaac/shared/errors'
import { mediaType } from '@yaac/shared/media-types'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type {
  SymlinkTarget,
  WorkspaceDir,
  WorkspaceFile,
  WorkspaceFileAtRev,
  WorkspaceFiles,
  BranchComparison,
  WorkspaceChanges,
  WorkspaceComparison,
  WorkspaceGitLog,
} from '@yaac/shared/types'
import { workspaceDriver } from '#drivers/driver'
import { WorkspaceExecError } from '#drivers/contract'
import {
  CHANGES_BASE_UNRESOLVED, CHANGES_BUSY, CHANGES_READING_GONE, readChangeDiffs, readComparison, readWorkspaceChanges,
  type ChangesReading,
} from './changes'
import { lastFetchedAtMs } from '#domain/git'
import { authorizeProject, type Actor } from '#domain/access'
import { ConfinedPathError, normalizeRel } from '#lib/confined-fs'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { MAX_TEXT_FILE_BYTES, isBinaryContent } from '#lib/text-file'
import { getWorkspaceRow, listWorkspaceRepos, type WorkspaceRepoRow } from '#db'
import { checkoutBlobAt, checkoutLog } from './checkout-git'
import { checkoutAt } from './checkouts'
import { resolveWorkspaceContainer, resolveWorkspaceRecord } from './resolve'
import {
  MAX_LISTED_PATHS, NoTreeError, runTreeRequest,
  type TreeArgs, type TreeOp, type TreeRequest, type TreeResult, type WorkspaceFileWrite,
} from './tree-ops'

export type { WorkspaceFileWrite } from './tree-ops'

/**
 * The webapp file editor's access to a workspace's files
 * (docs/file-editor.md). Every path is relative to the workspace dir,
 * whichever checkout it falls in. The operations themselves are in
 * `tree-ops.ts`, and run wherever the files can be reached as they are now:
 * inside a running k8s workspace, through its `yaac-files` helper, and
 * otherwise on the server's own view of the workspace dir, which is how a
 * containerless workspace and a stopped k8s one are read. The changes, the
 * ahead/behind count, the listing and the commit log need a checkout's git,
 * which runs inside the workspace, so they require it to be running, and
 * each names the checkout it reads (`checkoutOf`).
 */

/** The workspace's helper that runs `tree-ops.ts` inside it. */
const FILES_HELPER = 'yaac-files'
/** A helper call's deadline: one walk of a large tree at most. */
const HELPER_TIMEOUT_MS = 60_000
/** Bytes per helper call when streaming a file in or out. Base64 of a page
 *  stays well under an exec's 4 MiB output cap. */
const PAGE_BYTES = 2 * 1024 * 1024
/** Operations that change nothing, so a call that lost its transport may
 *  be sent again. */
const READ_OPS = new Set<TreeOp>(['dir', 'read', 'mediaSize', 'range', 'walkOutside', 'emptyDirs', 'locate'])
/** The refusals the helper may carry back; anything else is a fault. */
const REFUSALS = new Set<ErrorCode>(['NOT_FOUND', 'CONFLICT', 'VALIDATION', 'TOO_LARGE'])

/** Mutations of one workspace's checkout run one at a time. */
const mutate = createKeyedMutex()

interface Checkout {
  workspaceId: string
  projectId: string
  /** Each checkout's `.git`, which counts as outside the workspace, so the
   *  editor cannot plant a hook or config there. */
  exclude: string[]
  /** Its checkouts, as its rows record them. */
  repos: WorkspaceRepoRow[]
  /** Run one operation on the workspace's files. */
  call<K extends TreeOp>(op: K, args: TreeArgs<K>): Promise<TreeResult<K>>
}

/** Open a workspace's dir. A write passes its caller, who must own the
 *  workspace. */
async function openCheckout(idOrName: string, writer?: Actor): Promise<Checkout> {
  const { projectId, workspaceId, jobName, running } = await resolveWorkspaceRecord(idOrName)
  if (writer !== undefined) await authorizeProject(writer, projectId)
  const repos = await listWorkspaceRepos(workspaceId)
  const exclude = repos.map((r) => path.posix.join(r.path, '.git'))
  const driver = workspaceDriver()
  // A workspace whose files are on its node is reached through its pod. A
  // life from before that keeps them on the shared tier, read here, and its
  // pod has no helper (docs/legacy-compat-shims.md).
  const onNode = driver.kind === 'k8s' && (await getWorkspaceRow(projectId, workspaceId))?.treeDir !== undefined
  const inside = running && jobName !== undefined && onNode ? jobName : undefined
  // A stopped one has them nowhere the server can read
  // (docs/node-local-workspaces.md "File routes").
  if (inside === undefined && onNode) {
    throw new ServerError('CONFLICT', 'Start the workspace to browse its files')
  }
  const paths = inside !== undefined ? driver.workspacePaths(inside) : undefined
  const root = paths?.workspaceDir ?? workspaceDir(projectId, workspaceId)
  // A change made through the helper asks the tree container for a pass.
  const trigger = paths?.treeTrigger
  const call = async <K extends TreeOp>(op: K, args: TreeArgs<K>): Promise<TreeResult<K>> => {
    const req: TreeRequest<K> = { root, exclude, op, args, ...(trigger !== undefined && !READ_OPS.has(op) ? { trigger } : {}) }
    try {
      return inside !== undefined ? await callHelper(inside, req) : await runTreeRequest(req)
    } catch (err) {
      if (err instanceof NoTreeError) throw new ServerError('NOT_FOUND', `workspace ${idOrName} has no checkout`)
      throw err
    }
  }
  return { workspaceId, projectId, repos, exclude, call }
}

/** Run one operation in a workspace through its helper (`tree-helper.ts`),
 *  whose answer is agent-written. */
async function callHelper<K extends TreeOp>(jobName: string, req: TreeRequest<K>): Promise<TreeResult<K>> {
  const { stdout } = await workspaceDriver().exec(jobName, FILES_HELPER, {
    stdin: JSON.stringify(req),
    timeout: HELPER_TIMEOUT_MS,
    ...(READ_OPS.has(req.op) ? {} : { maxAttempts: 1 }),
  })
  let answer: { result?: TreeResult<K>; error?: { code?: unknown; message?: unknown }; noTree?: boolean; fault?: unknown }
  try {
    answer = JSON.parse(stdout) as typeof answer
  } catch {
    throw new Error(`${FILES_HELPER} ${req.op}: no answer`)
  }
  if (answer.noTree === true) throw new NoTreeError(req.root)
  const { code, message } = answer.error ?? {}
  if (REFUSALS.has(code as ErrorCode) && typeof message === 'string') throw new ServerError(code as ErrorCode, message)
  if ('result' in answer) return answer.result as TreeResult<K>
  throw new Error(`${FILES_HELPER} ${req.op}: ${typeof answer.fault === 'string' ? answer.fault : 'no answer'}`)
}

/**
 * The checkout a repo-scoped read means: the one `at` names, by its path
 * under the workspace root or its repo's id, or with no `at` the
 * workspace's only one (`checkoutAt`). Undefined for a workspace with no
 * repos when none is named, which has nothing to read.
 */
function checkoutOf(repos: WorkspaceRepoRow[], at: string | undefined): WorkspaceRepoRow | undefined {
  if (repos.length === 0 && at === undefined) return undefined
  const { path: found } = checkoutAt(repos.map((r) => ({ path: r.path, repo: { id: r.repoId } })), at)
  return repos.find((r) => r.path === found)
}

/** `rel`, a path in the checkout at `checkout`, as a path in the workspace. */
const underCheckout = (checkout: string, rel: string): string => (checkout === '' ? rel : `${checkout}/${rel}`)

/**
 * The running workspace to run a git read in. `CONFLICT` if it exists but is
 * not running, `NOT_FOUND` if unknown.
 */
async function runningWorkspace(idOrName: string): Promise<{ jobName: string; projectId: string; workspaceId: string }> {
  const { jobName } = await resolveWorkspaceRecord(idOrName)
  if (jobName === undefined) throw new ServerError('CONFLICT', `workspace ${idOrName} is not running`)
  return resolveWorkspaceContainer(idOrName, { requireRunning: true })
}

/** The lexical check every path gets before it is used, with a
 *  caller-facing error. */
function checkPath(co: Checkout, rel: string): string {
  try {
    return normalizeRel(rel, co.exclude)
  } catch (err) {
    throw err instanceof ConfinedPathError ? new ServerError('VALIDATION', err.message) : err
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The ref a checkout is compared against unless one is picked: origin's
 * copy of the branch it forked from, which every way of setting that branch
 * checks exists there. A checkout created at a commit has no such branch,
 * and is compared against that commit. A local copy of the fork branch is
 * never used, since nothing keeps it current.
 */
function forkBase(row: { baseBranch?: string; startCommit?: string } | undefined): string | undefined {
  return row?.baseBranch !== undefined ? `origin/${row.baseBranch}` : row?.startCommit
}

/**
 * Everything the webapp polls about a running workspace: the diff of one
 * checkout (`repo`, see `checkoutOf`) against its base, how far its HEAD is
 * from the base branch, and, when `listing` is asked for, every path of the
 * workspace for the explorer's tree. The diff's paths are relative to its
 * checkout, the listing's to the workspace dir. A workspace with no repos
 * answers no changes.
 *
 * An explicit `base` wins; otherwise it is compared against `forkBase`.
 * `diff: false` leaves the diff body out.
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
  opts: { repo?: string; diff?: boolean; listing?: 'paths' | 'full'; known?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceChanges> {
  const { jobName, projectId, workspaceId } = await runningWorkspace(idOrName)
  const row = await getWorkspaceRow(projectId, workspaceId)
  const repos = await listWorkspaceRepos(workspaceId)
  const checkout = checkoutOf(repos, opts.repo)
  // The runtime treats a blank `base` as unset.
  const named = base?.trim()
  // The listing covers every checkout, so each is read; the diff only one.
  const read = (r: WorkspaceRepoRow): Promise<ChangesReading> => readWorkspaceChanges(jobName, {
    checkout: r.path,
    ...(r === checkout ? { base } : {}),
    defaultBase: forkBase(r),
    diff: r === checkout && (opts.diff ?? true),
    listing: opts.listing,
  }, opts.signal)
  let readings: Array<{ repo: WorkspaceRepoRow; reading: ChangesReading }>
  try {
    readings = await Promise.all((opts.listing !== undefined ? repos : repos.filter((r) => r === checkout))
      .map(async (r) => ({ repo: r, reading: await read(r) })))
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
  const reading = readings.find((r) => r.repo === checkout)?.reading
  let comparison: BranchComparison | null = null
  if (reading?.ref && checkout) {
    const { ref } = reading
    comparison = { ref: ref.name, ahead: ref.ahead, behind: ref.behind }
    const fetchedAtMs = ref.name.startsWith('origin/')
      ? await lastFetchedAtMs(
        repoDir(checkout.repoId), ref.name.slice('origin/'.length),
        path.join(workspaceDir(projectId, workspaceId), checkout.path, '.git'),
      )
      : null
    if (fetchedAtMs !== null) comparison.fetchedAt = formatUtcTimestamp(fetchedAtMs)
  }
  const listing = opts.listing !== undefined
    ? await workspaceListing(await openCheckout(idOrName), jobName, readings, row?.scratchDirs ?? [], opts.listing)
    : undefined
  return {
    ...(reading?.changes ?? { base: '', work: '', baseResolved: true, files: [], truncated: false, ...(opts.diff ?? true ? { diff: '' } : {}) }),
    branch: named || checkout?.baseBranch || checkout?.startCommit || null,
    comparison,
    ...(listing && listing.version !== opts.known ? { listing } : {}),
    readMs: reading?.readMs ?? 0,
  }
}

/**
 * More of the diff a changes answer named by `base` and `work` (see
 * `readChangeDiffs`): the parts of `files` it left out, or with `skip` the
 * rest of one file's part. A reading whose trees are gone is NOT_FOUND, so
 * the caller polls again for a current one.
 */
export async function getWorkspaceChangeDiffs(
  idOrName: string, { repo, ...request }: Omit<Parameters<typeof readChangeDiffs>[1], 'checkout'> & { repo?: string },
): Promise<{ diff: string }> {
  const { jobName, workspaceId } = await runningWorkspace(idOrName)
  const checkout = checkoutOf(await listWorkspaceRepos(workspaceId), repo)
  if (!checkout) throw new ServerError('NOT_FOUND', 'that reading of the changes is gone; read them again')
  try {
    return { diff: await readChangeDiffs(jobName, { ...request, checkout: checkout.path }) }
  } catch (err) {
    if (err instanceof WorkspaceExecError && err.code === CHANGES_READING_GONE) {
      throw new ServerError('NOT_FOUND', 'that reading of the changes is gone; read them again')
    }
    throw err
  }
}

/**
 * The diff between two refs of one checkout of a running workspace (`repo`,
 * see `checkoutOf`), for a Changes pane showing a range or one commit
 * (`readComparison`). A ref that does not resolve, or a pair sharing no
 * history, is a VALIDATION error, as is any ref in a workspace with no
 * repos.
 */
export async function getWorkspaceComparison(
  idOrName: string,
  { repo, ...range }: { from?: string; to: string; repo?: string },
): Promise<WorkspaceComparison> {
  const { jobName, workspaceId } = await runningWorkspace(idOrName)
  const checkout = checkoutOf(await listWorkspaceRepos(workspaceId), repo)
  if (!checkout) throw new ServerError('VALIDATION', 'this workspace has no repos')
  try {
    return await readComparison(jobName, { ...range, checkout: checkout.path })
  } catch (err) {
    if (err instanceof WorkspaceExecError && err.code === CHANGES_BASE_UNRESOLVED) {
      const pair = range.from ? `"${range.from}" and "${range.to}"` : `"${range.to}"`
      throw new ServerError('VALIDATION', `${pair} give no diff in this workspace`)
    }
    throw err
  }
}

/**
 * The Commits pane's history of one checkout (`repo`, see `checkoutOf`):
 * HEAD's commits and those of the branch the checkout is based on, as the
 * changes read resolves it. A workspace with no repos has none.
 */
export async function getWorkspaceGitLog(idOrName: string, limit: number, repo?: string): Promise<WorkspaceGitLog> {
  const { jobName, workspaceId } = await runningWorkspace(idOrName)
  const checkout = checkoutOf(await listWorkspaceRepos(workspaceId), repo)
  if (!checkout) return { ref: null, head: null, commits: [], more: false }
  return await checkoutLog(jobName, { checkout: checkout.path, defaultBase: forkBase(checkout), limit })
}

/** Whether `rel` is a path the file routes would accept as written. */
function isListable(co: Checkout, rel: string): boolean {
  try {
    return normalizeRel(rel, co.exclude) === rel
  } catch {
    return false
  }
}

/**
 * The explorer's listing of a whole workspace, rooted at its dir: each
 * checkout's gitignore-aware listing under the checkout's folder, and, in a
 * workspace whose root is no checkout, whatever else is there, which git
 * lists nowhere, found by a plain walk (`walkOutside`). A checkout holding
 * no listed path still shows as a folder.
 */
async function workspaceListing(
  co: Checkout, jobName: string, readings: Array<{ repo: WorkspaceRepoRow; reading: ChangesReading }>,
  scratchDirs: string[], kind: 'paths' | 'full',
): Promise<WorkspaceFiles> {
  const outside = co.repos.some((r) => r.path === '')
    ? undefined
    : await co.call('walkOutside', { checkouts: co.repos.map((r) => r.path) })
  const merged = { paths: outside?.paths ?? [], links: outside?.links ?? [], conflicted: [] as string[] }
  const ignored: string[] = []
  const untrackedDirs = outside?.dirs ?? []
  const skippedDirs: string[] = []
  const changed: string[] = []
  for (const { repo, reading } of readings) {
    const under = (list: string[] | undefined): string[] => (list ?? []).map((p) => underCheckout(repo.path, p))
    merged.paths.push(...under(reading.listing?.paths))
    merged.links.push(...under(reading.listing?.links))
    merged.conflicted.push(...under(reading.listing?.conflicted))
    ignored.push(...under(reading.listing?.ignored))
    untrackedDirs.push(...under(reading.listing?.untrackedDirs))
    skippedDirs.push(...under(reading.changes.skipped).filter((d) => d.endsWith('/')).map((d) => d.slice(0, -1)))
    changed.push(...under(reading.changes.files.map((f) => f.path)))
  }
  return finishListing(
    co, jobName, { ...merged, ...(kind === 'full' ? { ignored, untrackedDirs } : {}) },
    { dirs: scratchDirs, changed }, skippedDirs,
    { folders: co.repos.map((r) => r.path).filter((p) => p !== ''), truncated: outside?.truncated === true },
  )
}

/**
 * The explorer's listing from what the scripts read: capped, with where each
 * symlink leads and, for a `full` listing, the folders holding no file. Its
 * `root` is where the workspace sees its dir. `extra.folders` are shown even
 * when no listed path is in them.
 *
 * A `full` listing also reports each of the workspace's scratch dirs
 * (docs/project-config.md "Scratch directories") as a wholly ignored
 * folder, so the explorer hides it like one, unless it holds a path of
 * `paths` or a `changed` one (a tracked file deleted there): nothing git
 * cares about is hidden. A dir counts as a real folder only when the empty
 * folders name it or something in it, or the ignored entries name
 * something in it.
 *
 * The diff's skipped folders are listed as one entry each, which the
 * explorer reads on expand, so none of their untracked folders is walked.
 * A skipped file is in `paths` already, added with intent to add.
 */
async function finishListing(
  co: Checkout, jobName: string, read: NonNullable<ChangesReading['listing']>,
  scratch: { dirs: string[]; changed: string[] }, skippedDirs: string[],
  extra: { folders: string[]; truncated: boolean },
): Promise<WorkspaceFiles> {
  // The script runs in the workspace, so every list may name anything. Only
  // paths the file routes accept are kept, before any is opened or resolved.
  const listable = (list: string[]): string[] => list.filter((p) => isListable(co, p.replace(/\/$/, '')))
  const listed = listable(read.paths)
  const listedIgnored = listable(read.ignored ?? [])
  // One cap for every list, so no checkout makes the answer unbounded.
  const truncated = extra.truncated || listed.length > MAX_LISTED_PATHS || listedIgnored.length > MAX_LISTED_PATHS
  const paths = listed.slice(0, MAX_LISTED_PATHS)
  let ignored = listedIgnored.slice(0, MAX_LISTED_PATHS)
  const skipped = listable(skippedDirs)
  const untracked = listable(read.untrackedDirs ?? []).filter((d) => !skipped.some((s) => `${d}/`.startsWith(`${s}/`)))
  let emptyDirs = [
    ...extra.folders.filter((dir) => !listed.some((p) => p.startsWith(`${dir}/`))),
    ...read.untrackedDirs && untracked.length > 0
      ? await co.call('emptyDirs', { untrackedDirs: untracked, paths, ignored: [...ignored, ...skipped.map((d) => `${d}/`)] })
      : [],
  ]
  // Sorted, so a dir inside another scratch dir is already under its entry.
  for (const dir of [...scratch.dirs].sort()) {
    const inDir = (p: string): boolean => p === dir || p.startsWith(`${dir}/`)
    if (listed.some(inDir) || scratch.changed.some(inDir)) continue
    if (ignored.some((e) => e.endsWith('/') && `${dir}/`.startsWith(e))) continue
    if (!emptyDirs.some(inDir) && !ignored.some((e) => e.startsWith(`${dir}/`))) continue
    ignored = [...ignored.filter((e) => !inDir(e)), `${dir}/`]
    emptyDirs = emptyDirs.filter((p) => !inDir(p))
  }
  // git records a link as one entry and never lists what is behind it.
  // Built in path order, so an unchanged listing hashes the same.
  const links = listable(read.links).slice(0, MAX_LISTED_PATHS)
  const targets = links.length > 0 ? await co.call('locate', { rels: links }) : []
  const symlinks: Record<string, SymlinkTarget> = Object.fromEntries(links.map((p, i) => [p, targets[i]]))
  const body = {
    root: workspaceDriver().workspacePaths(jobName).workspaceDir,
    paths,
    symlinks,
    ignored,
    emptyDirs,
    ...skipped.length ? { skipped } : {},
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
  return co.call('dir', { rel: checkPath(co, relPath) })
}

/**
 * Read one file. `content` is omitted when `known` is still the file's
 * version, and null when it is binary or over the editable size.
 */
export async function readWorkspaceFile(idOrName: string, relPath: string, known?: string): Promise<WorkspaceFile> {
  const co = await openCheckout(idOrName)
  return co.call('read', { rel: checkPath(co, relPath), ...(known !== undefined ? { known } : {}) })
}

/** A media file's bytes, as the file pane's media view reads them. */
export interface WorkspaceMedia {
  type: string
  size: number
  /** The inclusive byte range served, or null for the whole file. */
  range: { start: number; end: number } | null
  body: ReadableStream<Uint8Array<ArrayBuffer>>
}

/**
 * The one range a `Range: bytes=…` header asks for, clamped to the file. A
 * header this cannot satisfy (several ranges, past the end) gets the whole
 * file, which HTTP allows.
 */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1])
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start <= end ? { start, end } : null
}

/**
 * Stream an image, video, audio or PDF file (by extension, `mediaType`),
 * or the byte range `range` asks for, so a video can seek. Any other file is
 * refused, so a browser is never handed bytes it might run as a page. The
 * bytes are read a page at a time as the stream is pulled, and the end is
 * fixed by the size read first, so a file growing mid-read cannot overrun
 * the declared length.
 */
export async function readWorkspaceMedia(idOrName: string, relPath: string, range?: string): Promise<WorkspaceMedia> {
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  const type = mediaType(rel)
  if (type === null) throw new ServerError('VALIDATION', `${rel} is not an image, video, audio or PDF file`)
  const size = await co.call('mediaSize', { rel })
  const slice = byteRange(range, size)
  const end = slice?.end ?? size - 1
  let at = slice?.start ?? 0
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (at > end) {
        controller.close()
        return
      }
      const page = Buffer.from(await co.call('range', { rel, start: at, length: Math.min(PAGE_BYTES, end - at + 1) }), 'base64')
      if (page.length === 0) throw new Error(`${rel} ended before its ${String(size)} bytes`)
      at += page.length
      controller.enqueue(new Uint8Array(page))
    },
  })
  return { type, size, range: slice, body }
}
/**
 * One file's text at commit `rev` (the fork base the changes diff reports)
 * of the checkout its path is in, which the editor's diff modes compare the
 * working copy against. Read with the workspace's git, so it must be
 * running.
 */
export async function readWorkspaceFileAtRev(
  idOrName: string,
  relPath: string,
  rev: string,
): Promise<WorkspaceFileAtRev> {
  // A full object id, so it can be neither an option nor a revision range.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev)) throw new ServerError('VALIDATION', `${rev} is not a commit id`)
  const { jobName } = await runningWorkspace(idOrName)
  const co = await openCheckout(idOrName)
  const rel = checkPath(co, relPath)
  // The checkout whose folder the file is in; a file in none is in no commit.
  const checkout = co.repos.find((r) => r.path === '' || rel.startsWith(`${r.path}/`))
  if (!checkout) return { exists: false, content: null }
  const blob = await checkoutBlobAt(jobName, checkout.path, rev, path.posix.relative(checkout.path, rel), MAX_TEXT_FILE_BYTES)
  if (blob === 'absent') return { exists: false, content: null }
  if (blob === 'large' || isBinaryContent(blob)) return { exists: true, content: null }
  return { exists: true, content: blob.toString('utf8') }
}

/** Save one file against the version the editor last saw (`TreeOps.write`). */
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
  return mutate(co.workspaceId, () => co.call('write', { rel, data: data.toString('base64'), baseVersion }))
}

/** A request body cut into pages of `PAGE_BYTES`. */
async function* pagesOf(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Buffer> {
  let held: Buffer[] = []
  let size = 0
  for await (const chunk of body ?? []) {
    held.push(Buffer.from(chunk))
    size += chunk.length
    while (size >= PAGE_BYTES) {
      const all = Buffer.concat(held)
      yield all.subarray(0, PAGE_BYTES)
      held = [all.subarray(PAGE_BYTES)]
      size -= PAGE_BYTES
    }
  }
  if (size > 0) yield Buffer.concat(held)
}

/**
 * Write a file the webapp uploads, making any missing parent folders. A
 * conflict if something is already there, unless `replace`.
 *
 * A new file is made empty and filled as the request arrives, and removed if
 * the upload fails partway. A replacement is taken in full into a staging
 * file beside it first, so a dropped upload leaves the original untouched.
 * Only then, under the edit lock so two replaces never interleave, are the
 * bytes copied into the target in place, as a save writes it: following a
 * link while it stays inside, keeping the mode and inode.
 */
export async function uploadWorkspaceFile(
  principal: Actor,
  idOrName: string,
  relPath: string,
  body: ReadableStream<Uint8Array> | null,
  replace: boolean,
): Promise<{ path: string }> {
  const co = await openCheckout(idOrName, principal)
  const rel = checkPath(co, relPath)
  const into = replace ? await co.call('stage', { rel }) : rel
  if (!replace) await co.call('create', { rel })
  try {
    let offset = 0
    for await (const page of pagesOf(body)) {
      await co.call('append', { rel: into, offset, data: page.toString('base64') })
      offset += page.length
    }
    if (replace) await mutate(co.workspaceId, () => co.call('replace', { rel, from: into }))
  } catch (err) {
    await co.call('remove', { rel: into }).catch(() => {})
    throw err
  }
  return { path: rel }
}

/** Create a folder and any missing parents; a conflict if anything is
 *  already there. */
export async function createWorkspaceFolder(principal: Actor, idOrName: string, relPath: string): Promise<{ path: string }> {
  const co = await openCheckout(idOrName, principal)
  const rel = checkPath(co, relPath)
  await mutate(co.workspaceId, () => co.call('mkdir', { rel }))
  return { path: rel }
}

/**
 * Move a file, folder or symlink (the link itself), creating missing parent
 * folders. A conflict if the destination exists.
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
  await mutate(co.workspaceId, () => co.call('rename', { from, to }))
  return { from, to }
}

/**
 * Delete a file, a symlink (the link, never what it points to) or a folder
 * with everything in it.
 */
export async function deleteWorkspaceEntry(principal: Actor, idOrName: string, relPath: string): Promise<void> {
  const co = await openCheckout(idOrName, principal)
  const rel = checkPath(co, relPath)
  await mutate(co.workspaceId, () => co.call('remove', { rel }))
}
