/**
 * Client side of the file editor (docs/file-editor.md): layout targets for
 * the explorer and editor panes, their API calls, and helpers that turn the
 * server's flat listing into a tree, quick-open results and tab labels.
 */
import { ServerError } from '@yaac/shared/errors'
import type {
  FileStatus,
  SymlinkTarget,
  WorkspaceDir,
  WorkspaceFile,
  WorkspaceFiles,
  WorkspaceFileSaved,
} from '@yaac/shared/types'
import { api, rawApi } from './api'
import { FILE_STATUS_RANK } from './gitStatus'
import { addColumn, addTab, groupIndexOf, moveTargetToColumn, paneTargets, type PaneLayout } from './layout'

/** The one layout target a workspace's explorer uses. */
export const FILES_TARGET = 'files'

const FILE_PREFIX = 'file:'

export function isFilesTarget(target: string): boolean {
  return target === FILES_TARGET
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

export function listWorkspaceFiles(workspaceId: string): Promise<WorkspaceFiles> {
  return api.workspace[':id'].files.$get({ param: { id: workspaceId } })
}

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
  return await res.json() as WorkspaceFileSaved
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
  /** A file's own status, or the strongest among a folder's files. */
  status?: FileStatus
  ignored?: boolean
  /** An ignored folder listed as one entry; its children are fetched from
   *  the folder route when it is expanded. */
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
 * `showIgnored`, flagged ignored entries. A folder takes the strongest
 * status among its files.
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
 * column right of the explorer, else a new column at the end.
 */
export function placeFile(ws: PaneLayout, target: string, activeTarget?: string): PaneLayout {
  if (paneTargets(ws).includes(target)) return ws
  const active = activeTarget && isFileTarget(activeTarget) ? groupIndexOf(ws, activeTarget) : -1
  const withFile = active !== -1 ? active : ws.findIndex((g) => g.tabs.some(isFileTarget))
  if (withFile !== -1) return addTab(ws, withFile, target)
  const explorer = groupIndexOf(ws, FILES_TARGET)
  const added = addColumn(ws, target)
  return explorer === -1 ? added : moveTargetToColumn(added, target, explorer + 1)
}
