/**
 * The file editor's client half (docs/file-editor.md): the layout targets of
 * the explorer and the editor panes, the API calls behind them, and the pure
 * helpers that turn the server's flat listing into a tree, a quick-open
 * result list and tab labels.
 */
import { ServerError } from '@yaac/shared/errors'
import type {
  FileStatus,
  SymlinkTarget,
  WorktreeDir,
  WorktreeFile,
  WorktreeFiles,
  WorktreeFileSaved,
} from '@yaac/shared/types'
import { api, rawApi } from './api'
import { FILE_STATUS_RANK } from './gitStatus'
import { addColumn, addTab, groupIndexOf, moveTargetToColumn, paneTargets, type Workspace } from './layout'

/** The one layout target a worktree's explorer uses. */
export const FILES_TARGET = 'files'

const FILE_PREFIX = 'file:'

export function isFilesTarget(target: string): boolean {
  return target === FILES_TARGET
}

/** The editor pane of one file, by its path relative to the worktree. */
export function fileTarget(path: string): string {
  return `${FILE_PREFIX}${path}`
}

export function isFileTarget(target: string): boolean {
  return target.startsWith(FILE_PREFIX)
}

export function fileTargetPath(target: string): string {
  return target.slice(FILE_PREFIX.length)
}

/** What names one open file across the app: its dirty mark and its saver. */
export function fileKey(worktreeId: string, path: string): string {
  return `${worktreeId}|${path}`
}

// ── API ────────────────────────────────────────────────────────────────

export function listWorktreeFiles(worktreeId: string): Promise<WorktreeFiles> {
  return api.worktree[':id'].files.$get({ param: { id: worktreeId } })
}

export function listWorktreeDir(worktreeId: string, path: string): Promise<WorktreeDir> {
  return api.worktree[':id'].dir.$get({ param: { id: worktreeId }, query: { path } })
}

/** `known`: the version the caller holds, which the server answers without
 *  content while it is still current. */
export function readWorktreeFile(worktreeId: string, path: string, known?: string): Promise<WorktreeFile> {
  return api.worktree[':id'].file.$get({
    param: { id: worktreeId },
    query: known === undefined ? { path } : { path, known },
  })
}

/** A save refused because the file is no longer the version it was made
 *  against. `version` is what the file is now; null when it is gone. */
export class FileConflict extends Error {
  constructor(readonly version: string | null) {
    super(version === null ? 'the file no longer exists' : 'the file changed on disk')
  }
}

/** Save against `baseVersion` (null: create). A refusal throws `FileConflict`. */
export async function saveWorktreeFile(
  worktreeId: string,
  path: string,
  content: string,
  baseVersion: string | null,
): Promise<WorktreeFileSaved> {
  const res = await rawApi.worktree[':id'].file.$put({
    param: { id: worktreeId },
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
  return await res.json() as WorktreeFileSaved
}

export function createWorktreeFolder(worktreeId: string, path: string): Promise<{ path: string }> {
  return api.worktree[':id'].folder.$post({ param: { id: worktreeId }, json: { path } })
}

export function renameWorktreeEntry(worktreeId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return api.worktree[':id'].rename.$post({ param: { id: worktreeId }, json: { from, to } })
}

export async function deleteWorktreeEntry(worktreeId: string, path: string): Promise<void> {
  await api.worktree[':id'].file.$delete({ param: { id: worktreeId }, query: { path } })
}

// ── Savers ─────────────────────────────────────────────────────────────

/**
 * What the rest of the app can ask of an editor pane's saver: a close or a
 * rename must first land its unsaved text, and a delete must stop a pending
 * autosave. `flush` answers whether the buffer is clean once it settles —
 * false for a paused conflict or a failing save.
 *
 * A saver is registered while its pane is mounted, and outlives the pane
 * when it still holds unsaved text nobody chose to throw away (see
 * `WorktreeFile`); only `discardFileSavers` drops one on purpose.
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

/** Flush every open pane among `keys`; true when all of them landed. */
export async function flushFileSavers(keys: string[]): Promise<boolean> {
  const results = await Promise.all(keys.map((k) => savers.get(k)?.flush() ?? Promise.resolve(true)))
  return results.every(Boolean)
}

/** Drop these savers and anything they hold unsaved — their panes are being
 *  closed on purpose, or their files deleted. */
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
  /** A folder, or a symlink to one inside the worktree. */
  dir: boolean
  /** Folders only, folders first then by name. */
  children: TreeNode[]
  /** A file's own status, or the strongest among a folder's files. */
  status?: FileStatus
  ignored?: boolean
  /** A wholly ignored folder, listed as one entry: its children come from
   *  the folder route when it is expanded. */
  lazy?: boolean
  symlink?: SymlinkTarget
}

export interface FileTree {
  root: TreeNode
  /** Every node by path — how a folder link finds what it points to. */
  index: Map<string, TreeNode>
}

/**
 * Turn the flat listing into a tree: files, empty folders, and — with
 * `showIgnored` — the ignored entries, flagged. Folder statuses are rolled
 * up from their files, strongest first.
 */
export function buildTree(files: WorktreeFiles, showIgnored = false): FileTree {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  const index = new Map<string, TreeNode>([['', root]])
  const folder = (path: string): TreeNode => {
    const found = index.get(path)
    if (found) return found
    const slash = path.lastIndexOf('/')
    const parent = folder(slash === -1 ? '' : path.slice(0, slash))
    // An ignored folder that turns out to hold listed entries is walked
    // like any other.
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
      status: files.status[path],
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
  const settle = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    if (!node.dir || node.symlink) return
    let rank = FILE_STATUS_RANK.length
    for (const child of node.children) {
      settle(child)
      if (child.status && !child.ignored) rank = Math.min(rank, FILE_STATUS_RANK.indexOf(child.status))
    }
    if (node !== root && rank < FILE_STATUS_RANK.length) node.status = FILE_STATUS_RANK[rank]
  }
  settle(root)
  return { root, index }
}

/** How many files the tree holds under a folder — what a delete confirms. */
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
 * Where a newly opened file goes — VS Code's "open in the active editor
 * group". Already open: unchanged. Otherwise a tab of the column holding
 * the active file pane, then of any column holding one; failing both, a new
 * column right of the explorer, and failing that one at the end.
 */
export function placeFile(ws: Workspace, target: string, activeTarget?: string): Workspace {
  if (paneTargets(ws).includes(target)) return ws
  const active = activeTarget && isFileTarget(activeTarget) ? groupIndexOf(ws, activeTarget) : -1
  const withFile = active !== -1 ? active : ws.findIndex((g) => g.tabs.some(isFileTarget))
  if (withFile !== -1) return addTab(ws, withFile, target)
  const explorer = groupIndexOf(ws, FILES_TARGET)
  const added = addColumn(ws, target)
  return explorer === -1 ? added : moveTargetToColumn(added, target, explorer + 1)
}
