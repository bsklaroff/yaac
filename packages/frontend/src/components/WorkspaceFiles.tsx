import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type ChangeEvent, type DragEvent, type JSX, type KeyboardEvent, type ReactNode,
} from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ServerError } from '@yaac/shared/errors'
import { WORKTREE_REF, type SymlinkTarget, type WorkspaceChange, type WorkspaceDiff, type WorkspaceFiles as Listing } from '@yaac/shared/types'
import { DEFAULT_FONT_SIZE, layoutOf, paneViewKey, useUiStore } from '#lib/store'
import { ChangesStrip, CommitHeader } from '#components/ChangesStrip'
import { DiffView } from '#components/DiffView'
import { PaneFindBar, useFindQuery } from '#components/FindPanel'
import { LineCountsLabel } from '#components/LineCountsLabel'
import { PathLabel } from '#components/PathLabel'
import { TextSizeMenu } from '#components/TextSizeMenu'
import type { ParsedFileDiff } from '#lib/diff'
import { useChangeDiffs, type DiffWant } from '#lib/useChangeDiffs'
import { CHANGE_STAGES, ROW_STATUS, pathStatuses, type RowStatus } from '#lib/gitStatus'
import { languageForPath } from '#lib/highlight'
import { chordMatches, findChord, formatChord, textSizeStep } from '#lib/shortcuts'
import { CHANGES_POLL_MS, useComparison, useWorkspaceChanges, useWorkspaceFiles } from '#lib/useWorkspaceChanges'
import { useCheckout } from '#lib/checkouts'
import { useDiffFind, type DiffMatch } from '#lib/useDiffFind'
import { usePinchSize } from '#lib/usePinchSize'
import { useSavedScroll } from '#lib/useSavedScroll'
import { IS_MAC } from '#lib/platform'
import { paneTargets } from '#lib/layout'
import { PHONE_TEXT_PX, focusRaisesKeyboard, useIsMobile } from '#lib/viewport'
import { droppedUploads, pickedUploads, sendUploads, type Upload } from '#lib/upload'
import {
  CHANGES_TARGET,
  FILES_TARGET,
  FileConflict,
  buildTree,
  changesTarget,
  countFiles,
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  discardFileSavers,
  fileKey,
  fileTargetPath,
  filterPaths,
  flushFileSavers,
  isFileTarget,
  listWorkspaceDir,
  matchScore,
  renameWorkspaceEntry,
  saveWorkspaceFile,
  type ChangesRange,
  type TreeNode,
} from '#lib/files'
import {
  ChevronIcon, CollapseAllIcon, ExpandAllIcon, FileCodeIcon, FileConfigIcon, FileIcon,
  FileImageIcon, FileJsonIcon, FileShellIcon, FileTextIcon, FlatListIcon, FolderIcon, FolderOpenIcon, HideIcon,
  LoadingIcon, MoreIcon, NewFileIcon, NewFolderIcon, SearchIcon, ShowIcon, SymlinkIcon, TreeListIcon,
  UploadFilesIcon, UploadFolderIcon, WarningIcon,
} from '#lib/icons'
import {
  FIELD_BOX, POPUP, YButton, YConfirm, YContextMenu, YFileInput, YInput, YMenu, YMenuItem, YMenuPopup, YTip, YTooltip, YTooltipProvider,
  type YIconGlyph,
} from '#ui'

/** The most matches the filter lists. */
const MAX_MATCHES = 200

/** The listing a range's Changes pane builds its tree on: none, since it
 *  lists only what it compares. */
const NO_LISTING: Listing = {
  version: '', root: '', paths: [], symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false,
}

/** Left padding of a row at `depth`; a guide sits under its chevron. */
const indent = (depth: number): number => 6 + depth * 12

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

/** A file's icon and tint, by what kind of file its name says it is. */
function fileIcon(path: string): { Icon: typeof FileIcon; className: string } {
  if (IMAGE.test(path)) return { Icon: FileImageIcon, className: 'text-purple' }
  const language = languageForPath(path)
  switch (language) {
    case null: {
      const base = path.slice(path.lastIndexOf('/') + 1)
      return base.startsWith('.') || base.endsWith('.lock')
        ? { Icon: FileConfigIcon, className: 'text-subtle' }
        : { Icon: FileIcon, className: 'text-subtle' }
    }
    case 'md': return { Icon: FileTextIcon, className: 'text-info' }
    case 'json': return { Icon: FileJsonIcon, className: 'text-warning' }
    case 'yaml': case 'toml': case 'xml': case 'dockerfile':
      return { Icon: FileConfigIcon, className: 'text-purple' }
    case 'shell': return { Icon: FileShellIcon, className: 'text-success' }
    default: return { Icon: FileCodeIcon, className: 'text-info' }
  }
}

/**
 * One row of the tree. `path` is the displayed path, which may run through a
 * folder symlink; the server follows the link when it is opened. A flat
 * row's `name` is its whole path.
 */
interface Row {
  path: string
  name: string
  dir: boolean
  node?: TreeNode
  ignored: boolean
  /** How it differs from the diff base (a folder: the strongest among its
   *  files), or a merge conflict. */
  status?: RowStatus
  symlink?: SymlinkTarget
  /** How the file differs from the diff base, if it does. */
  change?: WorkspaceChange
}

function rowOf(node: TreeNode, path: string, ignored: boolean): Row {
  return {
    path, name: node.name, dir: node.dir, node,
    ignored: ignored || node.ignored === true, symlink: node.symlink,
  }
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const join = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)
/** The folder a row stands for when creating or uploading into it: itself
 *  if a real folder (not a link), else none. */
const folderOf = (row: Row): string | null => (row.dir && !row.symlink ? row.path : null)
/** The folder a drag over `target` would upload into, from the row under it. */
const dropFolder = (target: EventTarget): string =>
  (target instanceof Element ? target.closest<HTMLElement>('[data-drop-folder]')?.dataset.dropFolder : undefined) ?? ''
const isFileDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Editing =
  | { kind: 'file' | 'folder'; parent: string }
  | { kind: 'rename'; path: string }

/** The listing's error for a workspace that is not running. */
function isStopped(err: unknown): boolean {
  return err instanceof ServerError && err.code === 'CONFLICT'
}

/**
 * The file explorer (docs/file-editor.md): a tree from one gitignore-aware
 * listing, a filter that doubles as quick-open, a "show ignored" toggle, git
 * status colors, line counts against the diff base, create / rename /
 * delete, and uploads. As the Changes pane (`changedOnly`) it lists only the
 * changed files, as a tree or flat, each with its diff, which Cmd/Ctrl-F
 * searches. Unmounted off-screen; view state lives in the store. The list
 * below the header scales with `filesFontSize` through CSS `zoom`, so icons,
 * indents and diffs grow with the text; Cmd/Ctrl =/−/0, the "Aa" menu and a
 * pinch over the list set it. A pinch anywhere else in the pane zooms the
 * page.
 */
export function WorkspaceFiles({ workspaceId, changedOnly = false, range }: {
  workspaceId: string
  changedOnly?: boolean
  /** With `changedOnly`, the range shown instead of the workspace's own
   *  changes. */
  range?: ChangesRange
}): JSX.Element {
  const queryClient = useQueryClient()
  // The tree rides on the changes poll below, which asks for the listing
  // while the pane is mounted. A range's pane lists only what it compares,
  // so it needs no listing of the checkout.
  const listing = useWorkspaceFiles(workspaceId)
  const data = listing ?? (range ? NO_LISTING : undefined)
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['changes', workspaceId] }) }

  const target = changedOnly ? (range ? changesTarget(range) : CHANGES_TARGET) : FILES_TARGET
  const viewKey = paneViewKey(workspaceId, target)
  const view = useUiStore((s) => s.paneView[viewKey])
  const setPaneView = useUiStore((s) => s.setPaneView)
  const openFile = useUiStore((s) => s.openFile)
  const bindings = useUiStore((s) => s.bindings)
  const fontSize = useUiStore((s) => s.filesFontSize)
  const setFontSize = useUiStore((s) => s.setFilesFontSize)
  const pinch = usePinchSize(fontSize, setFontSize)
  const zoom = fontSize / DEFAULT_FONT_SIZE
  const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded])
  const collapsed = useMemo(() => new Set(view?.collapsed ?? []), [view?.collapsed])
  const openDiffs = useMemo(() => new Set(view?.openDiffs ?? []), [view?.openDiffs])
  const toggleDiff = (path: string): void => {
    const next = new Set(openDiffs)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPaneView(viewKey, { openDiffs: [...next] })
  }
  const showIgnored = view?.showIgnored === true
  const flat = changedOnly && view?.flat !== false
  const find = view?.find ?? ''
  const setExpanded = (paths: Set<string>): void => setPaneView(viewKey, { expanded: [...paths] })
  // The Changes pane's folders start open, so it records the closed ones.
  const isOpen = (path: string): boolean => (changedOnly ? !collapsed.has(path) : expanded.has(path))
  const toggle = (path: string): void => {
    const next = new Set(changedOnly ? collapsed : expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPaneView(viewKey, changedOnly ? { collapsed: [...next] } : { expanded: [...next] })
  }

  // Every row shows its line counts, so the explorer fetches the changes
  // too. The Changes pane needs only the paths, for conflicts. A range
  // ending at the working tree is a changes read against its own base; any
  // other is a comparison of two refs.
  const live = range === undefined || range.to === WORKTREE_REF
  const worktree = useWorkspaceChanges(workspaceId, {
    ...range ? { base: range.from ?? 'HEAD' } : {},
    diff: changedOnly && live,
    ...!range ? { listing: changedOnly ? 'paths' : 'full' } : {},
    poll: live && CHANGES_POLL_MS,
  })
  const compared = useComparison(workspaceId, live ? undefined : range)
  const changes: UseQueryResult<WorkspaceDiff> = live ? worktree : compared
  // Changes are of the checkout the workspace's switcher picks, with paths
  // relative to it; the tree is of the whole workspace dir, so each takes
  // the checkout's folder in front.
  const { known, repos, prefix } = useCheckout(workspaceId)
  const changed = useMemo(() => (changes.data?.files ?? []).map((c) => (prefix === '' ? c : {
    ...c,
    path: `${prefix}${c.path}`,
    ...(c.oldPath !== undefined ? { oldPath: `${prefix}${c.oldPath}` } : {}),
  })), [changes.data?.files, prefix])
  const changeByPath = useMemo(() => new Map(changed.map((c) => [c.path, c])), [changed])
  const conflicted = range ? undefined : data?.conflicted
  const statuses = useMemo(() => pathStatuses(changed, conflicted ?? []), [changed, conflicted])
  const { diffs: diffMap, failed: diffFailed, want: wantDiff } = useChangeDiffs(
    workspaceId, changedOnly ? changes.data : undefined,
  )
  // The Changes pane's filter matches paths (a rename's old one too) as
  // quick-open does.
  const visibleChanged = useMemo(
    () => (find
      ? changed.filter((c) => [c.path, c.oldPath].some((p) => p !== undefined && matchScore(find, p) !== null))
      : changed),
    [changed, find],
  )

  const tree = useMemo(() => {
    if (!data) return null
    if (!changedOnly) return buildTree(data, showIgnored)
    const paths = visibleChanged.map((c) => c.path)
    return buildTree({ ...data, paths, symlinks: {}, ignored: [], emptyDirs: [] })
  }, [data, showIgnored, changedOnly, visibleChanged])
  const searchable = useMemo(() => (data
    ? [...data.paths, ...(showIgnored ? data.ignored.filter((p) => !p.endsWith('/')) : [])]
    : []), [data, showIgnored])
  const matches = useMemo(
    () => (find && !changedOnly ? filterPaths(searchable, find, MAX_MATCHES) : []),
    [searchable, find, changedOnly],
  )
  const ignoredFiles = useMemo(() => new Set(data?.ignored ?? []), [data?.ignored])

  // The open-files and open-changes shortcuts (Alt-E, Alt-G) set
  // findPending; the pane focuses its filter in response, making Alt-E, a
  // few letters, Enter a quick-open. Not where focus would raise a soft
  // keyboard (focusRaisesKeyboard).
  const findPending = useUiStore((s) => s.findPending === target)
  const setFindPending = useUiStore((s) => s.setFindPending)
  const findRef = useRef<HTMLInputElement | null>(null)
  // The highlighted quick-open result: arrows move it, Enter opens it.
  const [active, setActive] = useState(0)
  const setFind = (query: string): void => {
    setActive(0)
    setPaneView(viewKey, { find: query })
  }
  const matchesRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    matchesRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  useEffect(() => {
    if (!findPending || !findRef.current) return
    setFindPending(null)
    if (focusRaisesKeyboard()) return
    findRef.current.focus()
    findRef.current.select()
  }, [findPending, data, setFindPending])

  // Cmd/Ctrl-F searches the Changes pane's diffs, in the order shown.
  const searched = useMemo(() => {
    if (!changedOnly || !tree) return []
    const order = (n: TreeNode): string[] => (n.dir ? n.children.flatMap(order) : [n.path])
    const paths = flat ? visibleChanged.map((c) => c.path) : order(tree.root)
    return paths.flatMap((p) => diffMap.get(p) ?? [])
  }, [changedOnly, tree, flat, visibleChanged, diffMap])
  // Unfold the diff and the folders a match sits in.
  const reveal = ({ path }: DiffMatch): void => {
    const folders = path.split('/').slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join('/'))
    setPaneView(viewKey, {
      ...!openDiffs.has(path) && { openDiffs: [...openDiffs, path] },
      ...!flat && folders.some((f) => collapsed.has(f)) && {
        collapsed: [...collapsed].filter((p) => !folders.includes(p)),
      },
    })
  }
  const findQuery = useFindQuery()
  const finder = useDiffFind(searched, findQuery, reveal)
  // Each file's matches by line, kept across steps so a step re-renders only
  // the diffs of the old and new current match.
  const marks = useMemo(() => {
    const byPath = new Map<string, Map<number, DiffMatch[]>>()
    if (!findQuery.isOpen) return byPath
    for (const m of finder.located) {
      const lines = byPath.get(m.path) ?? new Map<number, DiffMatch[]>()
      byPath.set(m.path, lines)
      lines.set(m.line, [...lines.get(m.line) ?? [], m])
    }
    return byPath
  }, [findQuery.isOpen, finder.located])
  const currentMatch = findQuery.isOpen ? finder.located[finder.current] : undefined
  const rootRef = useRef<HTMLDivElement | null>(null)

  const onKeyDown = (e: KeyboardEvent): void => {
    const size = textSizeStep(e)
    if (size !== null) {
      e.preventDefault()
      setFontSize(size === 0 ? DEFAULT_FONT_SIZE : fontSize + size)
      return
    }
    if (!chordMatches(findChord(), e.nativeEvent)) return
    e.preventDefault()
    if (changedOnly) {
      findQuery.open()
    } else if (findRef.current) {
      findRef.current.focus()
      findRef.current.select()
    }
  }

  const [list, setList] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (finder.moved) list?.querySelector('[data-find-current]')?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [finder.moved])
  const onListScroll = useSavedScroll(viewKey, list)

  // ── create / rename / delete ────────────────────────────────────────
  const [selected, setSelected] = useState<Row | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null)
  const [menu, setMenu] = useState<{ row: Row | null; anchor: Element } | null>(null)
  const [contextRow, setContextRow] = useState<Row | null>(null)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const [replacing, setReplacing] = useState<{ parent: string; uploads: Upload[] } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const filesInput = useRef<HTMLInputElement | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  /** The folder the open file picker uploads into. */
  const pickParent = useRef('')

  const startEdit = (next: Editing): void => {
    setEditError(null)
    setActionError(null)
    setEditing(next)
    if (next.kind !== 'rename' && next.parent) {
      setExpanded(new Set([...expanded, next.parent]))
    }
  }
  /** The folder a header create lands in: the selected folder, or the one
   *  holding the selected file, or the root. */
  const createParent = (): string => (selected ? (selected.dir ? selected.path : parentOf(selected.path)) : '')

  /** Open file panes at or under `path`. */
  const openUnder = (path: string): string[] => {
    const state = useUiStore.getState()
    return paneTargets(layoutOf(state.layouts, workspaceId)).filter(isFileTarget).map(fileTargetPath)
      .filter((p) => p === path || p.startsWith(`${path}/`))
  }

  const commitEdit = async (value: string): Promise<void> => {
    if (!editing) return
    const name = value.trim().replace(/^\/+|\/+$/g, '')
    if (!name) {
      setEditing(null)
      return
    }
    try {
      if (editing.kind === 'rename') {
        const to = join(parentOf(editing.path), name)
        if (to === editing.path) {
          setEditing(null)
          return
        }
        // Affected panes remount under the new path, so save their text first.
        const affected = openUnder(editing.path)
        if (!(await flushFileSavers(affected.map((p) => fileKey(workspaceId, p))))) {
          setEditError('Resolve unsaved changes first.')
          return
        }
        await renameWorkspaceEntry(workspaceId, editing.path, to)
        useUiStore.getState().renameFiles(workspaceId, editing.path, to)
      } else {
        const path = join(editing.parent, name)
        if (editing.kind === 'folder') {
          await createWorkspaceFolder(workspaceId, path)
        } else {
          await saveWorkspaceFile(workspaceId, path, '', null)
          openFile(workspaceId, path)
        }
        // Every folder along a nested name opens, so the result shows.
        const opened = new Set(expanded)
        const segments = path.split('/')
        for (let i = 1; i < segments.length; i++) {
          opened.add(segments.slice(0, i).join('/'))
        }
        setExpanded(opened)
      }
      setEditing(null)
      refresh()
    } catch (e) {
      setEditError(e instanceof FileConflict ? 'Something with that name already exists.' : errMessage(e))
    }
  }

  const doDelete = async (row: Row): Promise<void> => {
    setConfirmDelete(null)
    const affected = openUnder(row.path)
    // Drop the affected panes' unsaved text and pending autosaves.
    discardFileSavers(affected.map((p) => fileKey(workspaceId, p)))
    try {
      await deleteWorkspaceEntry(workspaceId, row.path)
      useUiStore.getState().closeFiles(workspaceId, affected)
      if (selected?.path === row.path) setSelected(null)
      refresh()
    } catch (e) {
      setActionError(errMessage(e))
    }
  }

  /** Upload into `parent`, opening it so the result shows. Uploads may
   *  overlap, so the progress line counts across all of them. Files already
   *  there are offered for replacing once the rest are done. */
  const upload = async (parent: string, uploads: Upload[], replace = false): Promise<void> => {
    if (uploads.length === 0) return
    setActionError(null)
    setUploading((u) => ({ done: u?.done ?? 0, total: (u?.total ?? 0) + uploads.length }))
    const { taken, failed } = await sendUploads(workspaceId, parent, uploads, replace, () => {
      setUploading((u) => u && { ...u, done: u.done + 1 })
    })
    setUploading((u) => (u && u.done < u.total ? u : null))
    const opened = new Set(useUiStore.getState().paneView[viewKey]?.expanded ?? [])
    const segments = parent ? parent.split('/') : []
    segments.forEach((_, i) => opened.add(segments.slice(0, i + 1).join('/')))
    setExpanded(opened)
    refresh()
    if (failed.length) {
      setActionError(`Couldn’t upload ${failed.length === 1 ? failed[0] : `${failed.length} files. ${failed[0]}`}`)
    }
    if (taken.length) setReplacing({ parent, uploads: taken })
  }
  const openPicker = (input: HTMLInputElement | null, parent: string): void => {
    pickParent.current = parent
    input?.click()
  }
  const onPicked = (e: ChangeEvent<HTMLInputElement>): void => {
    const uploads = e.target.files ? pickedUploads(e.target.files) : []
    // Cleared so picking the same files again still fires a change.
    e.target.value = ''
    void upload(pickParent.current, uploads)
  }
  const onDrop = (e: DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setDropTarget(null)
    const parent = dropFolder(e.target)
    void droppedUploads(e.dataTransfer).then((uploads) => upload(parent, uploads))
  }

  const replaceText = ({ parent, uploads }: { parent: string; uploads: Upload[] }): { title: string; description: string } => {
    const paths = uploads.map((u) => join(parent, u.path))
    if (paths.length === 1) {
      return { title: `Replace “${paths[0]}”?`, description: 'It already exists. Replacing it overwrites its contents.' }
    }
    const more = paths.length > 5 ? `, and ${paths.length - 5} more` : ''
    return {
      title: `Replace ${paths.length} existing files?`,
      description: `${paths.slice(0, 5).join(', ')}${more} already exist. Replacing them overwrites their contents.`,
    }
  }

  const deleteText = (row: Row): { title: string; description: string } => {
    const dirty = useUiStore.getState().dirtyFiles
    const unsaved = openUnder(row.path).filter((p) => dirty[fileKey(workspaceId, p)])
    const lost = unsaved.length ? ` Unsaved changes in ${unsaved.join(', ')} will be lost.` : ''
    if (row.symlink) {
      return { title: `Delete link “${row.path}”?`, description: `This removes the link only, not what it points to.${lost}` }
    }
    if (row.dir) {
      const n = row.node && !row.node.lazy ? countFiles(row.node) : null
      const what = n === null ? 'everything in it' : `its ${n} file${n === 1 ? '' : 's'}`
      return { title: `Delete “${row.path}” and ${what}?`, description: `This can't be undone.${lost}` }
    }
    return { title: `Delete “${row.path}”?`, description: `This can't be undone.${lost}` }
  }

  /** The rows of both the context menu and a row's ⋯ menu, whose items
   *  are the same base-ui part. */
  const menuItems = (row: Row | null): ReactNode => {
    const folder = row === null ? '' : folderOf(row)
    return (
      <>
        {folder !== null && (
          <>
            <YMenuItem icon={NewFileIcon} onClick={() => startEdit({ kind: 'file', parent: folder })}>New file</YMenuItem>
            <YMenuItem icon={NewFolderIcon} onClick={() => startEdit({ kind: 'folder', parent: folder })}>New folder</YMenuItem>
            {!changedOnly && (
              <>
                <YMenuItem icon={UploadFilesIcon} onClick={() => openPicker(filesInput.current, folder)}>
                  Upload files…
                </YMenuItem>
                <YMenuItem icon={UploadFolderIcon} onClick={() => openPicker(folderInput.current, folder)}>
                  Upload folder…
                </YMenuItem>
              </>
            )}
          </>
        )}
        {row !== null && (
          <>
            <YMenuItem onClick={() => startEdit({ kind: 'rename', path: row.path })}>Rename</YMenuItem>
            <YMenuItem onClick={() => setConfirmDelete(row)}>Delete</YMenuItem>
          </>
        )}
      </>
    )
  }

  // ── rendering ───────────────────────────────────────────────────────
  if (changes.isError && isStopped(changes.error)) {
    // Listing needs the workspace running; open tabs still work when stopped.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-md text-muted">
        <span>Start the workspace to {changedOnly ? 'review its changes' : 'browse its files'}.</span>
      </div>
    )
  }
  if (!data || !tree) {
    if (!changes.isError) {
      return (
        <div className="flex h-full items-center justify-center bg-surface text-muted">
          <LoadingIcon size={18} className="animate-spin" />
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-md text-muted">
        <WarningIcon size={18} className="text-subtle" />
        <span>Couldn’t load files.</span>
        <span className="max-w-full truncate px-4 text-sm text-subtle">{errMessage(changes.error)}</span>
        <YButton size="sm" onClick={() => void changes.refetch()}>Retry</YButton>
      </div>
    )
  }

  const input = (initial: string, depth: number): JSX.Element => (
    <div style={{ paddingLeft: indent(depth) }} className="py-0.5 pr-2">
      <InlineInput
        initial={initial}
        zoom={zoom}
        onCommit={(v) => void commitEdit(v)}
        onCancel={() => { setEditing(null); setEditError(null) }}
      />
      {editError && <div className="py-0.5 text-sm text-danger">{editError}</div>}
    </div>
  )

  const childRows = (row: Row): Row[] | 'lazy' => {
    const own = row.node
    if (own && own.dir && !own.symlink && !own.lazy) {
      return own.children.map((c) => rowOf(c, `${row.path}/${c.name}`, row.ignored))
    }
    if (row.symlink?.target != null) {
      const target = tree.index.get(row.symlink.target)
      if (target && target.dir && !target.symlink && !target.lazy) {
        return target.children.map((c) => rowOf(c, `${row.path}/${c.name}`, row.ignored))
      }
    }
    return 'lazy'
  }

  const renderRows = (rows: Row[], depth: number, parent: string): JSX.Element => (
    <>
      {editing && editing.kind !== 'rename' && editing.parent === parent && input('', depth)}
      {rows.map((listed) => {
        const row = {
          ...listed,
          status: listed.ignored ? undefined : statuses.get(listed.path),
          change: listed.dir ? undefined : changeByPath.get(listed.path),
        }
        const opens = row.change?.status !== 'deleted' && (!row.symlink || row.symlink.target !== null)
        return (
          <TreeRowView
            key={row.path}
            row={row}
            depth={depth}
            open={isOpen(row.path)}
            selected={selected?.path === row.path}
            renaming={editing?.kind === 'rename' && editing.path === row.path}
            dropping={dropTarget !== null && dropTarget === folderOf(row)}
            renameInput={input(row.name, depth)}
            onClick={() => {
              setSelected(row)
              if (row.dir) toggle(row.path)
              else if (opens) openFile(workspaceId, row.path)
            }}
            onContextMenu={() => setContextRow(row)}
            onMore={(anchor) => setMenu({ row, anchor })}
            diff={changedOnly && row.change ? {
              open: openDiffs.has(row.path),
              toggle: () => toggleDiff(row.path),
              body: (
                <ChangeDiff
                  change={row.change}
                  diff={diffMap.get(row.path)}
                  unfetched={changes.data?.diff === undefined ? (changes.isError ? 'failed' : 'loading')
                    : changes.data.truncated && !diffMap.has(row.path) ? (diffFailed(row.path) ? 'failed' : 'loading')
                      : undefined}
                  restFailed={diffFailed(row.path)}
                  {...changes.data?.truncated ? { want: wantDiff } : {}}
                  marks={marks.get(row.path)}
                  current={currentMatch?.path === row.path ? currentMatch : undefined}
                />
              ),
            } : undefined}
          >
            {row.dir && isOpen(row.path) && ((): JSX.Element => {
              const children = childRows(row)
              return children === 'lazy'
                ? <LazyRows workspaceId={workspaceId} parent={row} render={(rs) => renderRows(rs, depth + 1, row.path)} />
                : renderRows(children, depth + 1, row.path)
            })()}
          </TreeRowView>
        )
      })}
    </>
  )

  const openable = visibleChanged.filter((c) => c.status !== 'deleted')
  const shown = changedOnly ? openable.map((c) => c.path) : matches

  const anyDiffOpen = visibleChanged.some((c) => openDiffs.has(c.path))
  const anyFolderOpen = [...expanded].some((p) => tree.index.get(p)?.dir)
  // Expanding all leaves out the folders listed on demand (ignored ones and
  // links), which would each cost a request.
  const expandable = [...tree.index.values()]
    .filter((n) => n.dir && n.path && !n.lazy && !n.symlink && !n.ignored)
    .map((n) => n.path)
  const count = data.paths.length.toLocaleString()
  const countLabel = changedOnly
    ? find ? `${visibleChanged.length} of ${changed.length} changed` : `${changed.length} changed`
    : find ? `${matches.length}${matches.length === MAX_MATCHES ? '+' : ''} of ${count}` : `${count} files`
  const header = (
    <YTooltipProvider>
      <div className="@container flex h-8 shrink-0 items-center gap-1 border-b border-line px-1.5 text-sm text-muted">
        <label className={clsx(FIELD_BOX, 'flex h-6 min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-1.5 pr-1')}>
          <SearchIcon size={12} className="shrink-0 text-subtle" />
          <YInput
            bare
            ref={findRef}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setActive((i) => Math.min(Math.max(i + step, 0), Math.max(shown.length - 1, 0)))
                return
              }
              if (e.key === 'Enter' && shown[active]) {
                e.preventDefault()
                openFile(workspaceId, shown[active])
                return
              }
              if (e.key !== 'Escape') return
              e.stopPropagation()
              if (find !== '') setFind('')
              else e.currentTarget.blur()
            }}
            placeholder={changedOnly
              ? `Filter changed files… (${formatChord(bindings['open-changes'], IS_MAC)})`
              : `Go to file… (${formatChord(bindings['open-files'], IS_MAC)})`}
            aria-label={changedOnly ? 'Filter changed files' : 'Filter files'}
            spellCheck={false}
            className="flex-1 py-0.5 text-sm"
          />
          <span
            className="shrink-0 tabular-nums text-subtle"
            title={data.truncated ? 'Only the first 50,000 paths are listed.' : undefined}
          >
            {countLabel}
            {data.truncated && !changedOnly && '+'}
          </span>
        </label>
        <HeaderActions actions={changedOnly ? [
          { label: `Find in diffs (${formatChord(findChord(), IS_MAC)})`, icon: SearchIcon, onClick: findQuery.open },
          {
            label: flat ? 'Show as a tree' : 'Show as a flat list',
            icon: flat ? FlatListIcon : TreeListIcon,
            pressed: flat,
            onClick: () => setPaneView(viewKey, { flat: !flat }),
          },
          {
            label: anyDiffOpen ? 'Collapse all changes' : 'Show all changes',
            icon: anyDiffOpen ? CollapseAllIcon : ExpandAllIcon,
            onClick: () => setPaneView(viewKey, { openDiffs: anyDiffOpen ? [] : changed.map((c) => c.path) }),
          },
        ] : [
          {
            label: showIgnored ? 'Hide ignored files' : 'Show ignored files',
            icon: showIgnored ? ShowIcon : HideIcon,
            pressed: showIgnored,
            onClick: () => setPaneView(viewKey, { showIgnored: !showIgnored }),
          },
          { label: 'New file', icon: NewFileIcon, onClick: () => startEdit({ kind: 'file', parent: createParent() }) },
          { label: 'New folder', icon: NewFolderIcon, onClick: () => startEdit({ kind: 'folder', parent: createParent() }) },
          { label: 'Upload files', icon: UploadFilesIcon, onClick: () => openPicker(filesInput.current, createParent()) },
          { label: 'Upload folder', icon: UploadFolderIcon, onClick: () => openPicker(folderInput.current, createParent()) },
          {
            label: anyFolderOpen ? 'Collapse all folders' : 'Expand all folders',
            icon: anyFolderOpen ? CollapseAllIcon : ExpandAllIcon,
            onClick: () => setExpanded(anyFolderOpen ? new Set() : new Set(expandable)),
          },
        ]} />
        <TextSizeMenu size={fontSize} onChange={setFontSize} />
      </div>
    </YTooltipProvider>
  )

  const changesNotice = ((): JSX.Element | null => {
    if (!changedOnly) return null
    const center = 'flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center'
    if (known && repos.length === 0) {
      return <div className={center}><p className="text-md text-muted">This workspace has no repos</p></div>
    }
    if (!changes.data) {
      return changes.isError ? (
        <div className={clsx(center, 'gap-2 text-md text-muted')}>
          <WarningIcon size={18} className="text-subtle" />
          <span>Couldn’t load changes.</span>
          <YButton size="sm" onClick={() => void changes.refetch()}>Retry</YButton>
        </div>
      ) : (
        <div className={clsx(center, 'text-muted')}><LoadingIcon size={18} className="animate-spin" /></div>
      )
    }
    if (changed.length === 0 && !changes.data.skipped) {
      if (range) return <div className={center}><p className="text-md text-muted">No differences</p></div>
      // An unresolved base means the diff ran against HEAD and misses
      // committed work, so say that rather than "no changes".
      return changes.data.baseResolved ? (
        <div className={center}>
          <p className="text-md text-muted">No changes yet</p>
          <p className="text-sm text-subtle">Edits the agent makes in its workspace show up here.</p>
        </div>
      ) : (
        <div className={center}>
          <p className="text-md text-muted">Nothing uncommitted</p>
          <p className="text-sm text-subtle">
            Couldn’t find the fork point for the diff base, so committed work isn’t shown.
            Push that branch, or pick another base above.
          </p>
        </div>
      )
    }
    if (visibleChanged.length === 0 && find) {
      return <div className={center}><p className="text-md text-muted">No changes match “{find}”</p></div>
    }
    return null
  })()

  const flatRows = (): Row[] => visibleChanged.map((c) => ({
    path: c.path, name: c.path, dir: false, ignored: false,
  }))

  return (
    // Focusable so Cmd/Ctrl-F reaches the filter after a click in the list.
    // Files dropped on the explorer upload into the folder under the pointer.
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={changedOnly ? undefined : (e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropTarget(dropFolder(e.target))
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null) }}
      onDrop={changedOnly ? undefined : onDrop}
      className={clsx('flex h-full flex-col bg-surface outline-none',
        dropTarget === '' && 'ring-1 ring-inset ring-accent/60')}
    >
      {header}
      {!changedOnly && (
        <>
          <YFileInput ref={filesInput} multiple onChange={onPicked} />
          <YFileInput ref={folderInput} directory onChange={onPicked} />
        </>
      )}
      {range && !range.from && compared.data?.commit && (
        <CommitHeader workspaceId={workspaceId} commit={compared.data.commit} />
      )}
      {changedOnly && (
        <ChangesStrip
          workspaceId={workspaceId}
          range={range}
          data={changes.data}
          files={visibleChanged}
        />
      )}
      {changedOnly && findQuery.isOpen && (
        <PaneFindBar
          find={findQuery}
          matches={finder.matches}
          current={finder.current}
          onStep={finder.step}
          onClose={() => {
            findQuery.close()
            rootRef.current?.focus()
          }}
        />
      )}
      {uploading && (
        <div role="status" className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-sm text-muted">
          <LoadingIcon size={11} className="animate-spin" />
          Uploading {uploading.done} of {uploading.total}…
        </div>
      )}
      {actionError && (
        <div role="alert" className="shrink-0 border-b border-line px-2 py-1 text-sm text-danger">
          {actionError}
        </div>
      )}
      {/* The tree and counts below are the last answer that landed. */}
      {changes.isError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1 text-sm text-warning">
          <span className="min-w-0 flex-1 truncate" title={errMessage(changes.error)}>
            Not up to date: {errMessage(changes.error)}
          </span>
        </div>
      )}
      {changesNotice ?? (find && !changedOnly ? (
        <div
          ref={matchesRef}
          role="listbox"
          aria-label="Matching files"
          style={{ zoom }}
          {...pinch}
          className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-y-auto py-0.5"
        >
          {matches.length === 0 && <p className="px-3 py-2 text-md text-muted">No files match “{find}”</p>}
          {matches.map((path, i) => {
            const status = statuses.get(path)
            const change = changeByPath.get(path)
            const slash = path.lastIndexOf('/')
            const { Icon, className } = fileIcon(path)
            return (
              <YButton
                variant="bare"
                key={path}
                role="option"
                aria-selected={i === active}
                data-active={i === active || undefined}
                onClick={() => openFile(workspaceId, path)}
                onMouseMove={() => { if (i !== active) setActive(i) }}
                title={path}
                className={clsx('flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-md',
                  i === active && 'bg-selected', ignoredFiles.has(path) && 'opacity-50')}
              >
                <Icon size={13} className={clsx('shrink-0', className)} />
                <span className={clsx('shrink-0', status ? ROW_STATUS[status] : 'text-text')}>
                  {path.slice(slash + 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-subtle">{path.slice(0, Math.max(slash, 0))}</span>
                {change && !change.binary && <LineCountsLabel counts={change} className="text-xs" />}
                <StageBadges change={change} conflicted={status === 'conflicted'} />
              </YButton>
            )
          })}
        </div>
      ) : (
        <YContextMenu.Root>
          <YContextMenu.Trigger
            ref={setList}
            onContextMenuCapture={() => setContextRow(null)}
            // Clicking empty space clears the selection, so New file / New
            // folder target the root.
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }}
            onScroll={onListScroll}
            style={{ zoom }}
            {...pinch}
            className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-y-auto py-0.5"
          >
            {renderRows(flat ? flatRows() : tree.root.children.map((c) => rowOf(c, c.name, false)), 0, '')}
            {changedOnly && changes.data?.skipped?.map((path) => {
              const dir = path.endsWith('/')
              const { Icon, className } = dir ? { Icon: FolderIcon, className: 'text-accent/80' } : fileIcon(path)
              return (
                <div key={path} className="flex items-center gap-1.5 px-2 py-0.5 text-md">
                  <Icon size={13} className={clsx('shrink-0', className)} />
                  <span className={clsx('shrink-0', ROW_STATUS.added)}>{prefix}{path}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-subtle">
                    {dir ? 'over 2,000 files' : 'over 10 MB'}, not diffed
                  </span>
                </div>
              )
            })}
          </YContextMenu.Trigger>
          <YContextMenu.Portal>
            <YContextMenu.Positioner>
              <YContextMenu.Popup className={clsx('min-w-[160px]', POPUP)}>{menuItems(contextRow)}</YContextMenu.Popup>
            </YContextMenu.Positioner>
          </YContextMenu.Portal>
        </YContextMenu.Root>
      ))}

      <YMenu.Root open={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null) }}>
        <YMenuPopup anchor={menu?.anchor} side="bottom" align="end" sideOffset={4} className="min-w-[160px]">
          {menu && menuItems(menu.row)}
        </YMenuPopup>
      </YMenu.Root>

      <YConfirm
        open={confirmDelete !== null}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}
        {...(confirmDelete ? deleteText(confirmDelete) : { title: '', description: '' })}
        onConfirm={() => { if (confirmDelete) void doDelete(confirmDelete) }}
      />
      <YConfirm
        open={replacing !== null}
        onOpenChange={(open) => { if (!open) setReplacing(null) }}
        {...(replacing ? replaceText(replacing) : { title: '', description: '' })}
        confirmLabel="Replace"
        onConfirm={() => {
          if (!replacing) return
          setReplacing(null)
          void upload(replacing.parent, replacing.uploads, true)
        }}
      />
    </div>
  )
}

interface HeaderAction {
  label: string
  icon: YIconGlyph
  pressed?: boolean
  onClick: () => void
}

/**
 * The header's buttons beside the filter field. In a narrow pane (a tile
 * among several) they fold into a ⋯ menu, so they never draw over the field.
 */
function HeaderActions({ actions }: { actions: HeaderAction[] }): JSX.Element {
  return (
    <>
      <span className="flex shrink-0 items-center gap-1 @max-[22rem]:hidden">
        {actions.map((a) => <HeaderButton key={a.label} {...a} />)}
      </span>
      <YMenu.Root>
        <YMenu.Trigger render={<YButton variant="ghost" size="sm" icon={MoreIcon} aria-label="More actions" className="@min-[22rem]:hidden" />} />
        <YMenuPopup side="bottom" align="end" sideOffset={4}>
          {actions.map((a) => <YMenuItem key={a.label} icon={a.icon} onClick={a.onClick}>{a.label}</YMenuItem>)}
        </YMenuPopup>
      </YMenu.Root>
    </>
  )
}

function HeaderButton({ label, icon, pressed, onClick }: HeaderAction): JSX.Element {
  return (
    <YTooltip tip={<YTip title={label} />}>
      <YButton
        variant="ghost"
        size="sm"
        icon={icon}
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className="aria-pressed:text-text"
      />
    </YTooltip>
  )
}

/** A file's badge: a letter per stage its changes sit in, after a `!` for a
 *  merge conflict. */
function StageBadges({ change, conflicted }: { change?: WorkspaceChange; conflicted: boolean }): JSX.Element | null {
  const stages = change ? CHANGE_STAGES.filter(({ stage }) => change.stages[stage]) : []
  if (!conflicted && stages.length === 0) return null
  const badge = 'w-2.5 text-center'
  return (
    <span className="flex shrink-0 font-mono text-xs font-semibold">
      {conflicted && <span title="Conflicted" className={clsx(badge, ROW_STATUS.conflicted)}>!</span>}
      {stages.map(({ stage, label, letter, className }) => (
        <span key={stage} title={label[0].toUpperCase() + label.slice(1)} className={clsx(badge, className)}>{letter}</span>
      ))}
    </span>
  )
}

function TreeRowView({
  row, depth, open, selected, renaming, dropping = false, renameInput, onClick, onContextMenu, onMore, diff, children,
}: {
  row: Row
  depth: number
  open: boolean
  selected: boolean
  renaming: boolean
  /** Files dragged over the explorer would upload into this folder. */
  dropping?: boolean
  renameInput: JSX.Element
  onClick: () => void
  onContextMenu: () => void
  onMore: (anchor: Element) => void
  /** A changed file's diff, shown under its row at full width while
   *  `open`. Clicking the row folds it; only the name opens the file. */
  diff?: { open: boolean; toggle: () => void; body: ReactNode }
  children?: ReactNode
}): JSX.Element {
  const broken = row.symlink !== undefined && row.symlink.target === null
  const deleted = row.change?.status === 'deleted'
  const tint = row.status && ROW_STATUS[row.status]
  const renamedFrom = row.change?.oldPath && row.change.oldPath !== row.path ? row.change.oldPath : undefined
  const { Icon, className: iconClass } = row.dir
    ? { Icon: open ? FolderOpenIcon : FolderIcon, className: 'text-accent/80' }
    : fileIcon(row.name)
  const name = row.name.includes('/') ? <PathLabel path={row.name} baseClassName={tint} /> : row.name
  // The row is a button, except a diff row: it holds the name's own button,
  // which a button cannot contain.
  const mainProps = {
    title: broken
      ? `${row.path} — broken link, or points outside the workspace`
      : renamedFrom ? `${renamedFrom} → ${row.path}` : row.path,
    'aria-expanded': row.dir ? open : undefined,
    style: { paddingLeft: indent(depth) },
    className: clsx('flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-7 text-left text-md hover:bg-hover',
      (row.ignored || broken) && 'opacity-50', (broken || (deleted && !diff)) && 'cursor-default',
      diff && 'cursor-pointer'),
  }
  const content = (
    <>
      {diff ? (
        // Its click reaches the row, which folds the diff; a button so
        // the keyboard can do the same.
        <YButton
          variant="bare"
          aria-label={`${diff.open ? 'Hide' : 'Show'} the diff of ${row.path}`}
          aria-expanded={diff.open}
          className="flex shrink-0 text-subtle hover:text-text"
        >
          <ChevronIcon size={11} className={clsx('transition-transform', diff.open && 'rotate-90')} />
        </YButton>
      ) : (
        <ChevronIcon
          size={11}
          className={clsx('shrink-0 text-subtle transition-transform', !row.dir && 'invisible', open && 'rotate-90')}
        />
      )}
      <Icon size={13} className={clsx('shrink-0', iconClass)} />
      {diff && !deleted ? (
        <YButton
          variant="bare"
          onClick={(e) => { e.stopPropagation(); onClick() }}
          title={`Open ${row.path}`}
          className={clsx('min-w-0 truncate text-left hover:underline', tint ?? 'text-text')}
        >
          {name}
        </YButton>
      ) : (
        <span className={clsx('min-w-0 truncate', tint ?? 'text-text', deleted && 'line-through')}>
          {name}
        </span>
      )}
      {row.symlink && (
        <span
          title={row.symlink.target === null ? 'Broken symlink, or points outside the workspace' : `Symlink to ${row.symlink.target}`}
          className="shrink-0 text-subtle"
        >
          <SymlinkIcon size={11} aria-label="symlink" />
        </span>
      )}
      <span className="ml-auto" />
      {row.change && !row.change.binary && <LineCountsLabel counts={row.change} className="text-xs" />}
      {row.dir
        ? tint && (
          <span title={`Contains ${row.status} files`} aria-label={row.status} className={clsx('shrink-0 text-xs', tint)}>
            ●
          </span>
        )
        : <StageBadges change={row.change} conflicted={row.status === 'conflicted'} />}
    </>
  )
  return (
    <>
      {renaming ? renameInput : (
        <div
          className={clsx('group/row relative flex items-center', selected && 'bg-selected', dropping && 'bg-accent/15')}
          onContextMenu={onContextMenu}
          data-drop-folder={folderOf(row) ?? parentOf(row.path)}
        >
          {diff
            ? <div {...mainProps} onClick={diff.toggle}>{content}</div>
            : <YButton variant="bare" {...mainProps} onClick={onClick}>{content}</YButton>}
          <YButton
            variant="bare"
            onClick={(e) => onMore(e.currentTarget)}
            title="More actions"
            aria-label={`More actions for ${row.path}`}
            className="absolute right-1 flex h-4 w-4 items-center justify-center rounded text-subtle opacity-0
              transition hover:text-text group-hover/row:opacity-100 max-md:opacity-100"
          >
            <MoreIcon size={11} />
          </YButton>
        </div>
      )}
      {diff?.open && diff.body}
      {children && (
        <div className="relative">
          {/* Guide line down the open folder's children. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-line-strong/60"
            style={{ left: indent(depth) + 5 }}
          />
          {children}
        </div>
      )}
    </>
  )
}

/** Diff lines per chunk that mounts on its own. */
const DIFF_CHUNK_LINES = 200
/** A diff row's height: `DiffView`'s 11px text at a 1.5 line height. */
const DIFF_LINE_PX = 16.5
/** `DiffView`'s monospace advance at 11px (0.6em in the font-mono faces),
 *  and the width its gutter and padding take from a row. */
const DIFF_CHAR_PX = 6.6
const DIFF_GUTTER_PX = 64

/** A chunk's height at `width` were each line to wrap at its last fitting
 *  character. Wrapping at spaces makes a few rows more, so this runs short. */
function estimateChunkPx(lines: ParsedFileDiff['lines'], width: number): number {
  const perRow = Math.max(1, Math.floor((width - DIFF_GUTTER_PX) / DIFF_CHAR_PX))
  return lines.reduce((px, line) => px + Math.max(1, Math.ceil(line.text.length / perRow)) * DIFF_LINE_PX, 0)
}

/**
 * One changed file's diff, read-only, under its row in the Changes pane.
 * It mounts in chunks as they come near the screen, so opening a view of
 * hundreds of changed files renders only the diffs in sight; the chunk
 * holding the current find match mounts regardless. `unfetched` says why
 * there is no diff for the file yet: it is `loading` until the pane's own
 * fetch lands (the shared changes poll leaves the body out while no Changes
 * pane is open), or the part the poll's cap left out does, unless that
 * `failed`. With a cut body, it tells `want` when it is near the screen:
 * its top wants the file's part, and the end of a part that was cut short
 * wants the rest.
 */
const ChangeDiff = memo(function ChangeDiff({ change, diff, unfetched, restFailed, want, marks, current }: {
  change: WorkspaceChange
  diff: ParsedFileDiff | undefined
  unfetched?: 'loading' | 'failed'
  restFailed: boolean
  want?: (path: string, kind: DiffWant, near: boolean) => void
  /** Find matches, by line index. */
  marks?: Map<number, DiffMatch[]>
  /** The current find match, when in this diff. */
  current?: DiffMatch
}): JSX.Element {
  // A chunk whose lines did not change keeps its array, so its measured
  // height holds while the rest of a long diff loads below it.
  const lastChunks = useRef<ParsedFileDiff['lines'][]>([])
  const chunks = useMemo(() => {
    const lines = diff && !diff.binary ? diff.lines : []
    const out: ParsedFileDiff['lines'][] = []
    for (let i = 0; i < lines.length; i += DIFF_CHUNK_LINES) {
      const chunk = lines.slice(i, i + DIFF_CHUNK_LINES)
      const last = lastChunks.current[out.length]
      const same = last?.length === chunk.length && last.every((l, k) => l.kind === chunk[k].kind && l.text === chunk[k].text
        && l.oldNo === chunk[k].oldNo && l.newNo === chunk[k].newNo)
      out.push(same ? last : chunk)
    }
    lastChunks.current = out
    return out
  }, [diff])
  const top = useNear(useCallback((near: boolean) => want?.(change.path, 'part', near), [want, change.path]))
  const end = useNear(useCallback((near: boolean) => want?.(change.path, 'rest', near), [want, change.path]))
  const chunkMarks = useMemo(() => chunks.map((_, i) => {
    const start = i * DIFF_CHUNK_LINES
    const own = [...marks ?? []].filter(([line]) => line >= start && line < start + DIFF_CHUNK_LINES)
    return own.length ? new Map(own.map(([line, m]) => [line - start, m])) : undefined
  }), [chunks, marks])
  const language = languageForPath(change.path)
  return (
    <div ref={want && top} className="border-y border-line bg-sunken">
      {chunks.length > 0 ? chunks.map((lines, i) => (
        <NearScreen
          key={i}
          content={lines}
          estimate={(width) => estimateChunkPx(lines, width)}
          force={current !== undefined && Math.floor(current.line / DIFF_CHUNK_LINES) === i}
        >
          <DiffView lines={lines} language={language} marks={chunkMarks[i]} current={current} />
        </NearScreen>
      )) : (
        <div className="px-3 py-1.5 text-sm text-subtle">
          {change.binary ? 'Binary file, no preview'
            : unfetched === 'loading' ? 'Loading diff…'
              : unfetched === 'failed' ? 'Diff not loaded'
                : 'No textual diff'}
        </div>
      )}
      {chunks.length > 0 && diff?.cut && (
        <div ref={want && end} className="px-3 py-1.5 text-sm text-subtle">
          {restFailed ? 'Couldn’t load the rest of this diff' : 'Loading more…'}
        </div>
      )}
    </div>
  )
})

/**
 * The one observer behind every `NearScreen`, and who to tell per element.
 * Its root is the viewport, so `rootMargin` alone would not reach past the
 * Changes list's own clip; `scrollMargin` widens that clip too, letting a
 * chunk mount before it scrolls into sight.
 */
let nearObserver: IntersectionObserver | null = null
const nearListeners = new Map<Element, (near: boolean) => void>()

/** A ref callback telling `onChange` whether its element is near the
 *  screen, and that it is not once the element goes. */
function useNear(onChange: (near: boolean) => void): (el: Element | null) => (() => void) | undefined {
  return useCallback((el: Element | null) => {
    if (!el) return
    const stop = observeNear(el, onChange)
    return () => {
      stop()
      onChange(false)
    }
  }, [onChange])
}

function observeNear(el: Element, onChange: (near: boolean) => void): () => void {
  nearObserver ??= new IntersectionObserver((entries) => {
    for (const e of entries) nearListeners.get(e.target)?.(e.isIntersecting)
  }, { rootMargin: '800px 0px', scrollMargin: '800px 0px' })
  nearListeners.set(el, onChange)
  nearObserver.observe(el)
  return () => {
    nearListeners.delete(el)
    nearObserver?.unobserve(el)
  }
}

/**
 * Renders its children only while within a screen or so of the viewport or
 * `force`d, holding their height in the meantime so the scrollbar stays
 * true. That height is what they measured when last unmounted, as long as
 * neither `content` nor the width has changed since; otherwise `estimate`'s
 * answer for the current width.
 */
function NearScreen({ content, estimate, force = false, children }: {
  /** What the children show, compared by identity. */
  content: unknown
  estimate: (width: number) => number
  force?: boolean
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const latestContent = useRef(content)
  const measured = useRef<{ content: unknown; width: number; px: number } | null>(null)
  const [near, setNear] = useState(false)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    latestContent.current = content
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = new ResizeObserver(() => setWidth(el.offsetWidth))
    resize.observe(el)
    const stopNear = observeNear(el, (n) => {
      if (!n && el.firstChild) {
        measured.current = { content: latestContent.current, width: el.offsetWidth, px: el.offsetHeight }
      }
      setNear(n)
    })
    return () => {
      resize.disconnect()
      stopNear()
    }
  }, [])
  const shown = near || force
  const m = measured.current
  const height = m && m.content === content && m.width === width ? m.px : estimate(width ?? Infinity)
  return <div ref={ref} style={shown ? undefined : { height }}>{shown && children}</div>
}

/** Children of a folder the listing omits (ignored, or a link), fetched on
 *  first expand. */
function LazyRows({ workspaceId, parent, render }: {
  workspaceId: string
  parent: Row
  render: (rows: Row[]) => JSX.Element
}): JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['dir', workspaceId, parent.path],
    queryFn: () => listWorkspaceDir(workspaceId, parent.path),
    refetchInterval: 5000,
  })
  if (isError) return <div className="px-3 py-0.5 text-sm text-subtle">Couldn’t list this folder.</div>
  if (!data) return <div className="px-3 py-0.5 text-sm text-subtle">Loading…</div>
  const rows: Row[] = data.entries
    .map((e) => ({
      path: `${parent.path}/${e.name}`,
      name: e.name,
      dir: e.dir || (e.symlink?.dir === true && e.symlink.target !== null),
      ignored: parent.ignored,
      symlink: e.symlink,
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return (
    <>
      {render(rows)}
      {data.truncated && <div className="px-3 py-0.5 text-sm text-subtle">First 5,000 shown</div>}
    </>
  )
}

/** The inline name input: Enter commits, Escape cancels. On phones its text
 *  is at least PHONE_TEXT_PX after the list's `zoom`, which iOS counts toward
 *  the size it zooms the page on focus below, and never smaller than the
 *  rows' own `text-md`. */
function InlineInput({ initial, zoom, onCommit, onCancel }: {
  initial: string
  zoom: number
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const mobile = useIsMobile()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name up to its extension, so typing replaces just that.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <YInput
      ref={ref}
      defaultValue={initial}
      aria-label="Name"
      spellCheck={false}
      style={mobile ? { fontSize: Math.max(PHONE_TEXT_PX / zoom, 12) } : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(e.currentTarget.value)
        else if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="w-full"
    />
  )
}
