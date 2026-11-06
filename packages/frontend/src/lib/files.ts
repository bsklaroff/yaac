/**
 * Client side of the file editor (docs/file-editor.md): layout targets for
 * the explorer and editor panes, their API calls, and helpers that turn the
 * server's flat listing into a tree, quick-open results, tab labels and the
 * links on file paths in terminal and chat text.
 */
import { ServerError } from '@yaac/shared/errors'
import { mediaType } from '@yaac/shared/media-types'
import type {
  SymlinkTarget,
  WorkspaceDir,
  WorkspaceFile,
  WorkspaceFiles,
  WorkspaceFileSaved,
} from '@yaac/shared/types'
import { api, rawApi } from './api'
import { refName } from './commits'
import { addColumn, addTab, groupIndexOf, moveTargetToColumn, paneTargets, type PaneLayout } from './layout'

/** The one layout target a workspace's explorer uses. */
export const FILES_TARGET = 'files'

/** The layout target of a workspace's own Changes pane: the explorer
 *  listing only the files changed since the fork with its base branch,
 *  each with its diff. */
export const CHANGES_TARGET = 'changes'

const RANGE_PREFIX = 'changes:'

/**
 * What a Changes pane opened on a range compares: from the merge base of
 * `from` and `to` to `to`, or with no `from`, one commit against its first
 * parent. `to` may be `WORKTREE_REF`. Each end is a branch on origin, a
 * commit or `HEAD`.
 */
export interface ChangesRange {
  from?: string
  to: string
}

const FILE_PREFIX = 'file:'

export function isFilesTarget(target: string): boolean {
  return target === FILES_TARGET
}

/** A Changes pane, the workspace's own or one on a range. */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET || target.startsWith(RANGE_PREFIX)
}

/** The Changes pane on a range: `changes:<from>...<to>`. A ref name holds
 *  no `..`, so the first `...` splits it. */
export function changesTarget({ from, to }: ChangesRange): string {
  return `${RANGE_PREFIX}${from ?? ''}...${to}`
}

/** A range as its pane's tab names it: one commit by its short sha, a
 *  range by both ends. */
export function rangeLabel({ from, to }: ChangesRange): string {
  return from === undefined ? refName(to) : `${refName(from)} → ${refName(to)}`
}

/** The range a Changes pane's target names; undefined for the workspace's
 *  own pane. */
export function changesRange(target: string): ChangesRange | undefined {
  if (!target.startsWith(RANGE_PREFIX)) return undefined
  const rest = target.slice(RANGE_PREFIX.length)
  const split = rest.indexOf('...')
  const from = rest.slice(0, split)
  return { ...from ? { from } : {}, to: rest.slice(split + 3) }
}

/** The editor pane of one file, by its path relative to the workspace. */
export function fileTarget(path: string): string {
  return `${FILE_PREFIX}${path}`
}

export function isFileTarget(target: string): boolean {
  return target.startsWith(FILE_PREFIX)
}

export function fileTargetPath(target: string): string {
  return target.slice(FILE_PREFIX.length)
}

/** Key for one open file, used for its dirty mark and its saver. */
export function fileKey(workspaceId: string, path: string): string {
  return `${workspaceId}|${path}`
}

// ── API ────────────────────────────────────────────────────────────────

export function listWorkspaceDir(workspaceId: string, path: string): Promise<WorkspaceDir> {
  return api.workspace[':id'].dir.$get({ param: { id: workspaceId }, query: { path } })
}

/** `known` is the version the caller holds; if it is still current the
 *  server omits the content. */
export function readWorkspaceFile(workspaceId: string, path: string, known?: string): Promise<WorkspaceFile> {
  return api.workspace[':id'].file.$get({
    param: { id: workspaceId },
    query: known === undefined ? { path } : { path, known },
  })
}

/** Where the browser loads a media file from. The version makes a changed
 *  file a new URL, so its view reloads. */
export function workspaceMediaUrl(workspaceId: string, path: string, version?: string): string {
  const query = new URLSearchParams(version === undefined ? { path } : { path, v: version })
  return `/api/workspace/${encodeURIComponent(workspaceId)}/raw?${query}`
}

/** The largest image a preview inlines, as for a chat attachment: the
 *  `data:` URL of a much bigger one can exhaust the tab. */
const MAX_PREVIEW_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * The bytes one preview may inline in all, and in any one file, so that many
 * files, or one file under many names (symlinks are followed), cannot
 * exhaust the tab either. A path holds one reservation, so reading it
 * again replaces its own.
 */
export class InlineBudget {
  private readonly held = new Map<string, number>()
  private total = 0

  constructor(private readonly limit = 32 * 1024 * 1024) {}

  /** Reserves `bytes` for `path`, unless that would go past the limit. */
  take(path: string, bytes: number): boolean {
    const total = this.total - (this.held.get(path) ?? 0) + bytes
    if (bytes > MAX_PREVIEW_IMAGE_BYTES || total > this.limit) return false
    this.held.set(path, bytes)
    this.total = total
    return true
  }

  /** Charges another copy of what `path` holds, for a page that writes one
   *  file out more than once, unless that would go past the limit. */
  again(path: string): boolean {
    const total = this.total + (this.held.get(path) ?? 0)
    if (total > this.limit) return false
    this.total = total
    return true
  }
}

/**
 * A checkout image as a `data:` URL, for a preview that loads nothing from
 * anywhere (docs/file-editor.md, "Previews"). An SVG comes from its text,
 * since the raw route refuses SVG, and runs no script as an image. Null
 * for a file that is not an image, cannot be read, or does not fit
 * `budget`; the raw route's `Content-Length` shows that before the body is
 * read.
 */
export async function imageDataUrl(workspaceId: string, path: string, budget: InlineBudget): Promise<string | null> {
  if (/\.svg$/i.test(path)) {
    const text = await readWorkspaceFile(workspaceId, path)
      .then((f) => (budget.take(path, f.size) ? f.content : null), () => null)
    return typeof text === 'string' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` : null
  }
  if (!mediaType(path)?.startsWith('image/')) return null
  const abort = new AbortController()
  const res = await fetch(workspaceMediaUrl(workspaceId, path), { signal: abort.signal }).catch(() => null)
  if (!res?.ok) return null
  if (!budget.take(path, Number(res.headers.get('content-length') ?? Infinity))) {
    abort.abort()
    return null
  }
  const blob = await res.blob()
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/** A save refused because the file changed since the version it was based
 *  on. `version` is the current version, or null if the file is gone. */
export class FileConflict extends Error {
  constructor(readonly version: string | null) {
    super(version === null ? 'the file no longer exists' : 'the file changed on disk')
  }
}

/** Save against `baseVersion` (null: create). A refusal throws `FileConflict`. */
export async function saveWorkspaceFile(
  workspaceId: string,
  path: string,
  content: string,
  baseVersion: string | null,
): Promise<WorkspaceFileSaved> {
  const res = await rawApi.workspace[':id'].file.$put({
    param: { id: workspaceId },
    json: { path, content, baseVersion },
  })
  if (res.status === 409) {
    const body = await res.json() as { version: string | null }
    throw new FileConflict(body.version)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { code: never; message: string } } | null
    throw new ServerError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? `server returned ${res.status}`)
  }
  return await res.json()
}

export function createWorkspaceFolder(workspaceId: string, path: string): Promise<{ path: string }> {
  return api.workspace[':id'].folder.$post({ param: { id: workspaceId }, json: { path } })
}

export function renameWorkspaceEntry(workspaceId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return api.workspace[':id'].rename.$post({ param: { id: workspaceId }, json: { from, to } })
}

export async function deleteWorkspaceEntry(workspaceId: string, path: string): Promise<void> {
  await api.workspace[':id'].file.$delete({ param: { id: workspaceId }, query: { path } })
}

// ── Savers ─────────────────────────────────────────────────────────────

/**
 * An editor pane's saver. A close or rename first saves unsaved text, and a
 * delete cancels a pending autosave. `flush` resolves to whether the buffer
 * is clean afterwards (false on a conflict or a failed save).
 *
 * A saver is registered while its pane is mounted and stays registered
 * after unmount while it holds unsaved text (see `WorkspaceFile`). Only
 * `discardFileSavers` removes one.
 */
export interface FileSaver {
  flush(): Promise<boolean>
  cancel(): void
}

const savers = new Map<string, FileSaver>()

/** The saver registered under a `fileKey`, if any. */
export function fileSaver<T extends FileSaver>(key: string): T | undefined {
  return savers.get(key) as T | undefined
}

export function registerFileSaver(key: string, saver: FileSaver): void {
  savers.set(key, saver)
}

/** Flush the savers for `keys`; true when all of them saved. */
export async function flushFileSavers(keys: string[]): Promise<boolean> {
  const results = await Promise.all(keys.map((k) => savers.get(k)?.flush() ?? Promise.resolve(true)))
  return results.every(Boolean)
}

/** Drop these savers and their unsaved text, when their panes are closed
 *  without saving or their files are deleted. */
export function discardFileSavers(keys: string[]): void {
  for (const k of keys) {
    savers.get(k)?.cancel()
    savers.delete(k)
  }
}

// ── Tree ───────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string
  path: string
  /** A folder, or a symlink to one inside the workspace. */
  dir: boolean
  /** Folders only, folders first then by name. */
  children: TreeNode[]
  ignored?: boolean
  /** An ignored or skipped folder listed as one entry; its children are
   *  fetched from the folder route when it is expanded. */
  lazy?: boolean
  symlink?: SymlinkTarget
}

export interface FileTree {
  root: TreeNode
  /** Every node by path, used to resolve folder symlinks. */
  index: Map<string, TreeNode>
}

/**
 * Turn the flat listing into a tree of files, empty folders and, with
 * `showIgnored`, flagged ignored entries.
 */
export function buildTree(files: WorkspaceFiles, showIgnored = false): FileTree {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  const index = new Map<string, TreeNode>([['', root]])
  const folder = (path: string): TreeNode => {
    const found = index.get(path)
    if (found) return found
    const slash = path.lastIndexOf('/')
    const parent = folder(slash === -1 ? '' : path.slice(0, slash))
    // An ignored folder that holds listed entries is not lazy.
    parent.lazy = false
    const node: TreeNode = { name: path.slice(slash + 1), path, dir: true, children: [] }
    parent.children.push(node)
    index.set(path, node)
    return node
  }
  const file = (path: string, extra: Partial<TreeNode>): void => {
    if (index.has(path)) return
    const slash = path.lastIndexOf('/')
    const parent = folder(slash === -1 ? '' : path.slice(0, slash))
    parent.lazy = false
    const node: TreeNode = { name: path.slice(slash + 1), path, dir: false, children: [], ...extra }
    parent.children.push(node)
    index.set(path, node)
  }
  for (const path of files.paths) {
    const link = files.symlinks[path]
    file(path, {
      dir: link?.dir === true && link.target !== null,
      ...(link ? { symlink: link } : {}),
    })
  }
  for (const path of files.emptyDirs) folder(path)
  if (showIgnored) {
    for (const entry of files.ignored) {
      if (entry.endsWith('/')) {
        const path = entry.slice(0, -1)
        const had = index.has(path)
        const node = folder(path)
        node.ignored = true
        if (!had) node.lazy = true
      } else {
        file(entry, { ignored: true })
      }
    }
  }
  // Last, since a tracked file inside one would make it a plain folder.
  for (const path of files.skipped ?? []) folder(path).lazy = true
  const settle = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const child of node.children) settle(child)
  }
  settle(root)
  return { root, index }
}

/** How many files are under a node, for the delete confirmation. */
export function countFiles(node: TreeNode): number {
  if (!node.dir || node.symlink) return 1
  return node.children.reduce((n, c) => n + countFiles(c), 0)
}

// ── Quick-open ─────────────────────────────────────────────────────────

/**
 * How well `query` matches `path` as a case-insensitive subsequence, or null
 * when it does not. Consecutive characters, segment starts and matches
 * inside the basename score higher, and a shorter path wins a tie.
 */
export function matchScore(query: string, path: string): number | null {
  const q = query.toLowerCase()
  const p = path.toLowerCase()
  const baseStart = p.lastIndexOf('/') + 1
  let score = 0
  let at = -1
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1)
    if (next === -1) return null
    score += 1
    if (next === at + 1) score += 3
    if (next === 0 || '/._-'.includes(p[next - 1])) score += 2
    if (next >= baseStart) score += 1
    at = next
  }
  if (p.slice(baseStart).includes(q)) score += 10
  return score - path.length / 1000
}

/** The paths matching `query`, best first, at most `limit` of them. */
export function filterPaths(paths: string[], query: string, limit = 200): string[] {
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const score = matchScore(query, path)
    if (score !== null) scored.push({ path, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.path)
}

// ── Paths in text ──────────────────────────────────────────────────────

/** A file in the checkout, and the line a link to it names. */
export interface FileRef {
  path: string
  line?: number
}

/** What file links match against: the checkout's absolute root as the
 *  workspace sees it, and its files relative to that (`WorkspaceFiles`). */
export interface CheckoutFiles {
  root: string
  paths: ReadonlySet<string>
}

/** A file path found in a run of text (a terminal row, a chat message), by
 *  string index. */
export type FileLink = FileRef & { start: number; end: number }

/** Runs of characters a path can be made of; quotes, brackets and the like
 *  end one. */
const TOKEN = /[^\s'"`()<>[\]{},;|]+/g

/** A token without the trailing `:line[:col]` and punctuation a path is
 *  often printed with. */
function trimToken(token: string): string {
  return token.replace(/[.:]+$/, '').replace(/(:\d+)+$/, '')
}

/** The paths in `text` that name checkout files (see `resolveFilePath`). */
export function fileLinksIn(text: string, files: CheckoutFiles): FileLink[] {
  const links: FileLink[] = []
  for (const m of text.matchAll(TOKEN)) {
    const ref = resolveFilePath(m[0], files)
    if (ref !== undefined) links.push({ ...ref, start: m.index, end: m.index + trimToken(m[0]).length })
  }
  return links
}

/**
 * The checkout file `token` names, if any, with the line of a trailing
 * `:line[:col]`. A token counts with an optional `./` and trailing
 * punctuation removed, and an absolute one only under the checkout's root,
 * so `/usr/lib/foo/package.json` never names the checkout's own.
 */
export function resolveFilePath(token: string, files: CheckoutFiles): FileRef | undefined {
  const trimmed = trimToken(token)
  if (!trimmed.includes('/') && !trimmed.includes('.')) return undefined
  const lineText = /^:(\d+)/.exec(token.slice(trimmed.length))?.[1]
  const relative = trimmed.startsWith(`${files.root}/`)
    ? trimmed.slice(files.root.length + 1)
    : trimmed.replace(/^\.\//, '')
  if (!files.paths.has(relative)) return undefined
  return lineText ? { path: relative, line: Number(lineText) } : { path: relative }
}

/** How a file pane can show a file rendered rather than as text. */
export function previewKind(path: string): 'markdown' | 'html' | null {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  return null
}

const CHECKOUT_ORIGIN = 'https://checkout.invalid'

/**
 * The checkout path a link in the file at `from` points to, resolved from
 * that file's folder, or null for a link elsewhere (a URL, `mailto:`). A
 * leading `/` is the checkout's root, as on GitHub, and `..` stops there.
 * The query and fragment are dropped.
 */
export function linkedCheckoutPath(from: string, href: string): string | null {
  try {
    const url = new URL(href, `${CHECKOUT_ORIGIN}/${from.split('/').map(encodeURIComponent).join('/')}`)
    return url.origin === CHECKOUT_ORIGIN ? decodeURIComponent(url.pathname.slice(1)) : null
  } catch {
    return null
  }
}

// ── Tabs and placement ─────────────────────────────────────────────────

/**
 * A tab label per open file: its basename, plus as much of its parent path
 * as it takes to tell apart two open files with the same name.
 */
export function fileTabLabels(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const byName = new Map<string, string[]>()
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  for (const [name, group] of byName) {
    if (group.length === 1) {
      out[group[0]] = name
      continue
    }
    const parents = group.map((p) => p.split('/').slice(0, -1))
    const deepest = Math.max(...parents.map((p) => p.length))
    let depth = 1
    const suffix = (segments: string[]): string => segments.slice(-depth).join('/')
    while (depth < deepest && new Set(parents.map(suffix)).size < group.length) depth++
    group.forEach((path, i) => { out[path] = parents[i].length ? `${name} · ${suffix(parents[i])}` : name })
  }
  return out
}

/**
 * Place a newly opened file, like VS Code's "open in the active editor
 * group". An open file stays put. Otherwise it becomes a tab in the column
 * with the active file pane, else any column with a file pane, else a new
 * column right of the explorer (the active one, if either is), else a new
 * column at the end.
 */
export function placeFile(ws: PaneLayout, target: string, activeTarget?: string): PaneLayout {
  if (paneTargets(ws).includes(target)) return ws
  const active = activeTarget && isFileTarget(activeTarget) ? groupIndexOf(ws, activeTarget) : -1
  const withFile = active !== -1 ? active : ws.findIndex((g) => g.tabs.some(isFileTarget))
  if (withFile !== -1) return addTab(ws, withFile, target)
  const explorer = [activeTarget, FILES_TARGET, CHANGES_TARGET]
    .filter((t): t is string => t === FILES_TARGET || t === CHANGES_TARGET)
    .map((t) => groupIndexOf(ws, t)).find((i) => i !== -1) ?? -1
  const added = addColumn(ws, target)
  return explorer === -1 ? added : moveTargetToColumn(added, target, explorer + 1)
}
