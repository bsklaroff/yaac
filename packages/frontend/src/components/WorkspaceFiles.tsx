import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ServerError } from '@yaac/shared/errors'
import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { Tooltip } from '@base-ui/react/tooltip'
import type { SymlinkTarget, WorkspaceChange, WorkspaceChanges } from '@yaac/shared/types'
import { layoutOf, paneViewKey, useUiStore } from '#lib/store'
import { BranchPicker } from '#components/BranchPicker'
import { DiffView } from '#components/DiffView'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { LineCountsLabel } from '#components/ui/LineCountsLabel'
import { PathLabel } from '#components/ui/PathLabel'
import { Tip, WithTip } from '#components/ui/Tooltip'
import { changeMatchesQuery, indexDiffsByPath, type ParsedFileDiff } from '#lib/diff'
import { CHANGE_STAGES, ROW_STATUS, lineTotals, pathStatuses, stageTotals, type RowStatus } from '#lib/gitStatus'
import { languageForPath } from '#lib/highlight'
import { chordMatches, findChord, formatChord } from '#lib/shortcuts'
import { useProjectBranches } from '#lib/useProjectBranches'
import { CHANGES_POLL_MS, useWorkspaceChanges, useWorkspaceFiles } from '#lib/useWorkspaceChanges'
import { IS_MAC } from '#lib/platform'
import { paneTargets } from '#lib/layout'
import {
  FILES_TARGET,
  FileConflict,
  buildTree,
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
  renameWorkspaceEntry,
  saveWorkspaceFile,
  type TreeNode,
} from '#lib/files'
import {
  BranchIcon, ChangesIcon, ChevronIcon, CollapseAllIcon, ExpandAllIcon, FileCodeIcon, FileConfigIcon, FileIcon,
  FileImageIcon, FileJsonIcon, FileShellIcon, FileTextIcon, FlatListIcon, FolderIcon, FolderOpenIcon, HideIcon,
  LoadingIcon, MoreIcon, NewFileIcon, NewFolderIcon, SearchIcon, ShowIcon, SymlinkIcon, TreeListIcon, WarningIcon,
} from '#lib/icons'

/** The most matches the filter lists. */
const MAX_MATCHES = 200

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
        ? { Icon: FileConfigIcon, className: 'text-text-faint' }
        : { Icon: FileIcon, className: 'text-text-faint' }
    }
    case 'md': return { Icon: FileTextIcon, className: 'text-link' }
    case 'json': return { Icon: FileJsonIcon, className: 'text-warning' }
    case 'yaml': case 'toml': case 'xml': case 'dockerfile':
      return { Icon: FileConfigIcon, className: 'text-purple' }
    case 'shell': return { Icon: FileShellIcon, className: 'text-success' }
    default: return { Icon: FileCodeIcon, className: 'text-link' }
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
 * status colors, line counts against the diff base, and create / rename /
 * delete. Its changes view lists only the changed files, as a tree or flat,
 * optionally with each one's diff. Unmounted off-screen; view state lives in
 * the store.
 */
export function WorkspaceFiles({ workspaceId, projectId, baseBranch }: {
  workspaceId: string
  projectId: string
  /** The branch the workspace forked from: the diff base picker's default. */
  baseBranch?: string
}): JSX.Element {
  const queryClient = useQueryClient()
  // The tree rides on the changes poll below, which asks for the full
  // listing while the explorer is mounted.
  const data = useWorkspaceFiles(workspaceId)
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['changes', workspaceId] }) }

  const viewKey = paneViewKey(workspaceId, FILES_TARGET)
  const view = useUiStore((s) => s.paneView[viewKey])
  const setPaneView = useUiStore((s) => s.setPaneView)
  const openFile = useUiStore((s) => s.openFile)
  const bindings = useUiStore((s) => s.bindings)
  const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded])
  const collapsed = useMemo(() => new Set(view?.collapsed ?? []), [view?.collapsed])
  const foldedDiffs = useMemo(() => new Set(view?.foldedDiffs ?? []), [view?.foldedDiffs])
  const toggleDiff = (path: string): void => {
    const next = new Set(foldedDiffs)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPaneView(viewKey, { foldedDiffs: [...next] })
  }
  const showIgnored = view?.showIgnored === true
  const changedOnly = view?.changedOnly === true
  const flat = changedOnly && view?.flat !== false
  const find = view?.find ?? ''
  const setExpanded = (paths: Set<string>): void => setPaneView(viewKey, { expanded: [...paths] })
  // The changes view's folders start open, so it records the closed ones.
  const isOpen = (path: string): boolean => (changedOnly ? !collapsed.has(path) : expanded.has(path))
  const toggle = (path: string): void => {
    const next = new Set(changedOnly ? collapsed : expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPaneView(viewKey, changedOnly ? { collapsed: [...next] } : { expanded: [...next] })
  }

  // Every row shows its line counts, so the changes are fetched in both
  // views; their diff lines only in the changes view, which shows them.
  const changes = useWorkspaceChanges(workspaceId, { diff: changedOnly, listing: 'full', poll: CHANGES_POLL_MS })
  // A picked base whose branch went away fails every poll; this goes back
  // to the fork branch.
  const pick = useUiStore((s) => s.changesBase[workspaceId])
  const resetPick = pick !== undefined && (
    <button
      onClick={() => useUiStore.getState().setChangesBase(workspaceId, undefined)}
      className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] text-text-dim transition hover:text-text"
    >
      Compare with {baseBranch ?? 'the fork branch'}
    </button>
  )
  const changed = useMemo(() => changes.data?.files ?? [], [changes.data?.files])
  const changeByPath = useMemo(() => new Map(changed.map((c) => [c.path, c])), [changed])
  const statuses = useMemo(() => pathStatuses(changed, data?.conflicted ?? []), [changed, data?.conflicted])
  const diffMap = useMemo(
    () => (changedOnly ? indexDiffsByPath(changes.data?.diff ?? '') : new Map<string, ParsedFileDiff>()),
    [changedOnly, changes.data?.diff],
  )
  // In the changes view the filter matches a path or a line of its diff.
  const visibleChanged = useMemo(
    () => changed.filter((c) => changeMatchesQuery(c, diffMap.get(c.path), find)),
    [changed, diffMap, find],
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

  // The open-files shortcut (Alt-E) sets filesFindPending; the pane focuses
  // its filter in response, making Alt-E, a few letters, Enter a quick-open.
  const findPending = useUiStore((s) => s.filesFindPending)
  const setFindPending = useUiStore((s) => s.setFilesFindPending)
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
    setFindPending(false)
    findRef.current.focus()
    findRef.current.select()
  }, [findPending, data, setFindPending])
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!chordMatches(findChord(), e.nativeEvent) || !findRef.current) return
    e.preventDefault()
    findRef.current.focus()
    findRef.current.select()
  }

  const listRef = useRef<HTMLDivElement | null>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || restoredScroll.current || !tree) return
    restoredScroll.current = true
    el.scrollTop = useUiStore.getState().paneView[viewKey]?.scroll ?? 0
  }, [viewKey, tree])

  // ── create / rename / delete ────────────────────────────────────────
  const [selected, setSelected] = useState<Row | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null)
  const [menu, setMenu] = useState<{ row: Row | null; anchor: Element } | null>(null)
  const [contextRow, setContextRow] = useState<Row | null>(null)

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

  const menuItems = (row: Row | null, Item: typeof Menu.Item): ReactNode => {
    const folder = row === null ? '' : row.dir && !row.symlink ? row.path : null
    return (
      <>
        {folder !== null && (
          <>
            <Item className={MENU_ITEM} onClick={() => startEdit({ kind: 'file', parent: folder })}>
              <NewFileIcon size={13} /> New file
            </Item>
            <Item className={MENU_ITEM} onClick={() => startEdit({ kind: 'folder', parent: folder })}>
              <NewFolderIcon size={13} /> New folder
            </Item>
          </>
        )}
        {row !== null && (
          <>
            <Item className={MENU_ITEM} onClick={() => startEdit({ kind: 'rename', path: row.path })}>Rename</Item>
            <Item className={MENU_ITEM} onClick={() => setConfirmDelete(row)}>Delete</Item>
          </>
        )}
      </>
    )
  }

  // ── rendering ───────────────────────────────────────────────────────
  if (changes.isError && isStopped(changes.error)) {
    // Listing needs the workspace running; open tabs still work when stopped.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <span>Start the workspace to browse its files.</span>
      </div>
    )
  }
  if (!data || !tree) {
    if (!changes.isError) {
      return (
        <div className="flex h-full items-center justify-center bg-surface text-text-dim">
          <LoadingIcon size={18} className="animate-spin" />
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <WarningIcon size={18} className="text-text-faint" />
        <span>Couldn’t load files.</span>
        <span className="max-w-full truncate px-4 text-[11px] text-text-faint">{errMessage(changes.error)}</span>
        <button
          onClick={() => void changes.refetch()}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
        >
          Retry
        </button>
        {resetPick}
      </div>
    )
  }

  const input = (initial: string, depth: number): JSX.Element => (
    <div style={{ paddingLeft: indent(depth) }} className="py-0.5 pr-2">
      <InlineInput
        initial={initial}
        onCommit={(v) => void commitEdit(v)}
        onCancel={() => { setEditing(null); setEditError(null) }}
      />
      {editError && <div className="py-0.5 text-[11px] text-error">{editError}</div>}
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
            renameInput={input(row.name, depth)}
            onClick={() => {
              setSelected(row)
              if (row.dir) toggle(row.path)
              else if (opens) openFile(workspaceId, row.path)
            }}
            onContextMenu={() => setContextRow(row)}
            onMore={(anchor) => setMenu({ row, anchor })}
            diff={changedOnly && row.change ? {
              open: !foldedDiffs.has(row.path),
              toggle: () => toggleDiff(row.path),
              body: <ChangeDiff change={row.change} diff={diffMap.get(row.path)} />,
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

  const anyDiffOpen = visibleChanged.some((c) => !foldedDiffs.has(c.path))
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
    <Tooltip.Provider>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-1.5 text-[11px] text-text-dim">
        <label
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded border border-border bg-bg pl-1.5 pr-1
            transition focus-within:border-border-strong"
        >
          <SearchIcon size={12} className="shrink-0 text-text-faint" />
          <input
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
            placeholder={changedOnly ? 'Filter changes…' : `Go to file… (${formatChord(bindings['open-files'], IS_MAC)})`}
            aria-label="Filter files"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-text outline-none placeholder:text-text-faint"
          />
          <span
            className="shrink-0 tabular-nums text-text-faint"
            title={data.truncated ? 'Only the first 50,000 paths are listed.' : undefined}
          >
            {countLabel}
            {data.truncated && !changedOnly && '+'}
          </span>
        </label>
        <HeaderButton
          label={changedOnly ? 'Show all files' : 'Show only changed files'}
          pressed={changedOnly}
          // The changes view opens as a flat list with every diff open, each time.
          onClick={() => setPaneView(viewKey, changedOnly
            ? { changedOnly: false }
            : { changedOnly: true, flat: true, foldedDiffs: [] })}
        >
          <ChangesIcon size={13} />
        </HeaderButton>
        {changedOnly ? (
          <>
            <HeaderButton
              label={flat ? 'Show as a tree' : 'Show as a flat list'}
              pressed={flat}
              onClick={() => setPaneView(viewKey, { flat: !flat })}
            >
              {flat ? <FlatListIcon size={13} /> : <TreeListIcon size={13} />}
            </HeaderButton>
            <HeaderButton
              label={anyDiffOpen ? 'Collapse all changes' : 'Show all changes'}
              onClick={() => setPaneView(viewKey, { foldedDiffs: anyDiffOpen ? changed.map((c) => c.path) : [] })}
            >
              {anyDiffOpen ? <CollapseAllIcon size={13} /> : <ExpandAllIcon size={13} />}
            </HeaderButton>
          </>
        ) : (
          <>
            <HeaderButton
              label={showIgnored ? 'Hide ignored files' : 'Show ignored files'}
              pressed={showIgnored}
              onClick={() => setPaneView(viewKey, { showIgnored: !showIgnored })}
            >
              {showIgnored ? <ShowIcon size={13} /> : <HideIcon size={13} />}
            </HeaderButton>
            <HeaderButton label="New file" onClick={() => startEdit({ kind: 'file', parent: createParent() })}>
              <NewFileIcon size={13} />
            </HeaderButton>
            <HeaderButton label="New folder" onClick={() => startEdit({ kind: 'folder', parent: createParent() })}>
              <NewFolderIcon size={13} />
            </HeaderButton>
            <HeaderButton
              label={anyFolderOpen ? 'Collapse all folders' : 'Expand all folders'}
              onClick={() => setExpanded(anyFolderOpen ? new Set() : new Set(expandable))}
            >
              {anyFolderOpen ? <CollapseAllIcon size={13} /> : <ExpandAllIcon size={13} />}
            </HeaderButton>
          </>
        )}
      </div>
    </Tooltip.Provider>
  )

  const changesNotice = ((): JSX.Element | null => {
    if (!changedOnly) return null
    const center = 'flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center'
    if (!changes.data) {
      return changes.isError ? (
        <div className={clsx(center, 'gap-2 text-xs text-text-dim')}>
          <WarningIcon size={18} className="text-text-faint" />
          <span>Couldn’t load changes.</span>
          <button
            onClick={() => void changes.refetch()}
            className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className={clsx(center, 'text-text-dim')}><LoadingIcon size={18} className="animate-spin" /></div>
      )
    }
    if (changed.length === 0) {
      // An unresolved base means the diff ran against HEAD and misses
      // committed work, so say that rather than "no changes".
      return changes.data.baseResolved ? (
        <div className={center}>
          <p className="text-xs text-text-dim">No changes yet</p>
          <p className="text-[11px] text-text-faint">Edits the agent makes in its workspace show up here.</p>
        </div>
      ) : (
        <div className={center}>
          <p className="text-xs text-text-dim">Nothing uncommitted</p>
          <p className="text-[11px] text-text-faint">
            Couldn’t find the fork point for the diff base, so committed work isn’t shown.
            Push that branch, or pick another base above.
          </p>
        </div>
      )
    }
    if (visibleChanged.length === 0) {
      return <div className={center}><p className="text-xs text-text-dim">No changes match “{find}”</p></div>
    }
    return null
  })()

  const flatRows = (): Row[] => visibleChanged.map((c) => ({
    path: c.path, name: c.path, dir: false, ignored: false,
  }))

  return (
    // Focusable so Cmd/Ctrl-F reaches the filter after a click in the list.
    <div tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full flex-col bg-surface outline-none">
      {header}
      {changedOnly && (
        <ChangesStrip
          workspaceId={workspaceId}
          projectId={projectId}
          baseBranch={baseBranch}
          data={changes.data}
          files={visibleChanged}
        />
      )}
      {actionError && (
        <div role="alert" className="shrink-0 border-b border-hairline px-2 py-1 text-[11px] text-error">
          {actionError}
        </div>
      )}
      {/* The tree and counts below are the last answer that landed. */}
      {changes.isError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 py-1 text-[11px] text-warning">
          <span className="min-w-0 flex-1 truncate" title={errMessage(changes.error)}>
            Not up to date: {errMessage(changes.error)}
          </span>
          {resetPick}
        </div>
      )}
      {changesNotice ?? (find && !changedOnly ? (
        <div ref={matchesRef} role="listbox" aria-label="Matching files" className="min-h-0 flex-1 overflow-y-auto py-0.5">
          {matches.length === 0 && <p className="px-3 py-2 text-xs text-text-dim">No files match “{find}”</p>}
          {matches.map((path, i) => {
            const status = statuses.get(path)
            const change = changeByPath.get(path)
            const slash = path.lastIndexOf('/')
            const { Icon, className } = fileIcon(path)
            return (
              <button
                key={path}
                role="option"
                aria-selected={i === active}
                data-active={i === active || undefined}
                onClick={() => openFile(workspaceId, path)}
                onMouseMove={() => { if (i !== active) setActive(i) }}
                title={path}
                className={clsx('flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs',
                  i === active && 'bg-surface-2', ignoredFiles.has(path) && 'opacity-50')}
              >
                <Icon size={13} className={clsx('shrink-0', className)} />
                <span className={clsx('shrink-0', status ? ROW_STATUS[status] : 'text-text')}>
                  {path.slice(slash + 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-faint">{path.slice(0, Math.max(slash, 0))}</span>
                {change && !change.binary && <LineCountsLabel counts={change} className="text-[10px]" />}
                <StageBadges change={change} conflicted={status === 'conflicted'} />
              </button>
            )
          })}
        </div>
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger
            ref={listRef}
            onContextMenuCapture={() => setContextRow(null)}
            // Clicking empty space clears the selection, so New file / New
            // folder target the root.
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }}
            onScroll={(e) => setPaneView(viewKey, { scroll: e.currentTarget.scrollTop })}
            className="min-h-0 flex-1 overflow-y-auto py-0.5"
          >
            {renderRows(flat ? flatRows() : tree.root.children.map((c) => rowOf(c, c.name, false)), 0, '')}
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner>
              <ContextMenu.Popup className={clsx('min-w-[160px]', POPUP)}>{menuItems(contextRow, ContextMenu.Item)}</ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ))}

      <Menu.Root open={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null) }}>
        <Menu.Portal>
          <Menu.Positioner anchor={menu?.anchor} side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className={clsx('min-w-[160px]', POPUP)}>{menu && menuItems(menu.row, Menu.Item)}</Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}
        {...(confirmDelete ? deleteText(confirmDelete) : { title: '', description: '' })}
        onConfirm={() => { if (confirmDelete) void doDelete(confirmDelete) }}
      />
    </div>
  )
}

function HeaderButton({ label, pressed, onClick, children }: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <WithTip tip={<Tip title={label} />}>
      <button
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded transition hover:bg-surface-2 hover:text-text',
          pressed ? 'text-text' : 'text-text-faint')}
      >
        {children}
      </button>
    </WithTip>
  )
}

/** A file's badge: a letter per stage its changes sit in, after a `!` for a
 *  merge conflict. */
function StageBadges({ change, conflicted }: { change?: WorkspaceChange; conflicted: boolean }): JSX.Element | null {
  const stages = change ? CHANGE_STAGES.filter(({ stage }) => change.stages[stage]) : []
  if (!conflicted && stages.length === 0) return null
  const badge = 'w-2.5 text-center'
  return (
    <span className="flex shrink-0 font-mono text-[10px] font-semibold">
      {conflicted && <span title="Conflicted" className={clsx(badge, ROW_STATUS.conflicted)}>!</span>}
      {stages.map(({ stage, label, letter, className }) => (
        <span key={stage} title={label[0].toUpperCase() + label.slice(1)} className={clsx(badge, className)}>{letter}</span>
      ))}
    </span>
  )
}

function TreeRowView({
  row, depth, open, selected, renaming, renameInput, onClick, onContextMenu, onMore, diff, children,
}: {
  row: Row
  depth: number
  open: boolean
  selected: boolean
  renaming: boolean
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
  // A diff row holds the name's own button, which a button cannot contain.
  const Main = diff ? 'div' : 'button'
  return (
    <>
      {renaming ? renameInput : (
        <div
          className={clsx('group/row relative flex items-center', selected && 'bg-surface-2')}
          onContextMenu={onContextMenu}
        >
          <Main
            onClick={diff ? diff.toggle : onClick}
            title={broken
              ? `${row.path} — broken link, or points outside the workspace`
              : renamedFrom ? `${renamedFrom} → ${row.path}` : row.path}
            aria-expanded={row.dir ? open : undefined}
            style={{ paddingLeft: indent(depth) }}
            className={clsx('flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-7 text-left text-xs hover:bg-surface-2',
              (row.ignored || broken) && 'opacity-50', (broken || (deleted && !diff)) && 'cursor-default',
              diff && 'cursor-pointer')}
          >
            {diff ? (
              // Its click reaches the row, which folds the diff; a button so
              // the keyboard can do the same.
              <button
                aria-label={`${diff.open ? 'Hide' : 'Show'} the diff of ${row.path}`}
                aria-expanded={diff.open}
                className="flex shrink-0 text-text-faint hover:text-text"
              >
                <ChevronIcon size={11} className={clsx('transition-transform', diff.open && 'rotate-90')} />
              </button>
            ) : (
              <ChevronIcon
                size={11}
                className={clsx('shrink-0 text-text-faint transition-transform', !row.dir && 'invisible', open && 'rotate-90')}
              />
            )}
            <Icon size={13} className={clsx('shrink-0', iconClass)} />
            {diff && !deleted ? (
              <button
                onClick={(e) => { e.stopPropagation(); onClick() }}
                title={`Open ${row.path}`}
                className={clsx('min-w-0 truncate text-left hover:underline', tint ?? 'text-text')}
              >
                {name}
              </button>
            ) : (
              <span className={clsx('min-w-0 truncate', tint ?? 'text-text', deleted && 'line-through')}>
                {name}
              </span>
            )}
            {row.symlink && (
              <span
                title={row.symlink.target === null ? 'Broken symlink, or points outside the workspace' : `Symlink to ${row.symlink.target}`}
                className="shrink-0 text-text-faint"
              >
                <SymlinkIcon size={11} aria-label="symlink" />
              </span>
            )}
            <span className="ml-auto" />
            {row.change && !row.change.binary && <LineCountsLabel counts={row.change} className="text-[10px]" />}
            {row.dir
              ? tint && (
                <span title={`Contains ${row.status} files`} aria-label={row.status} className={clsx('shrink-0 text-[9px]', tint)}>
                  ●
                </span>
              )
              : <StageBadges change={row.change} conflicted={row.status === 'conflicted'} />}
          </Main>
          <button
            onClick={(e) => onMore(e.currentTarget)}
            title="More actions"
            aria-label={`More actions for ${row.path}`}
            className="absolute right-1 flex h-4 w-4 items-center justify-center rounded text-text-faint opacity-0
              transition hover:text-text group-hover/row:opacity-100 max-md:opacity-100"
          >
            <MoreIcon size={11} />
          </button>
        </div>
      )}
      {diff?.open && diff.body}
      {children && (
        <div className="relative">
          {/* Guide line down the open folder's children. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border/60"
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

/**
 * One changed file's diff, read-only, under its row in the changes view.
 * It mounts in chunks as they come near the screen, so opening a view of
 * hundreds of changed files renders only the diffs in sight.
 */
function ChangeDiff({ change, diff }: { change: WorkspaceChange; diff: ParsedFileDiff | undefined }): JSX.Element {
  const chunks = useMemo(() => {
    const lines = diff && !diff.binary ? diff.lines : []
    const out: ParsedFileDiff['lines'][] = []
    for (let i = 0; i < lines.length; i += DIFF_CHUNK_LINES) out.push(lines.slice(i, i + DIFF_CHUNK_LINES))
    return out
  }, [diff])
  const language = languageForPath(change.path)
  return (
    <div className="overflow-x-auto border-y border-hairline bg-bg">
      {chunks.length > 0 ? chunks.map((lines, i) => (
        <NearScreen key={i} height={lines.length * DIFF_LINE_PX}>
          <DiffView lines={lines} language={language} />
        </NearScreen>
      )) : (
        <div className="px-3 py-1.5 text-[11px] text-text-faint">
          {change.binary ? 'Binary file, no preview' : 'No textual diff'}
        </div>
      )}
    </div>
  )
}

/** The one observer behind every `NearScreen`, and who to tell per element. */
let nearObserver: IntersectionObserver | null = null
const nearListeners = new Map<Element, (near: boolean) => void>()

function observeNear(el: Element, onChange: (near: boolean) => void): () => void {
  nearObserver ??= new IntersectionObserver((entries) => {
    for (const e of entries) nearListeners.get(e.target)?.(e.isIntersecting)
  }, { rootMargin: '800px 0px' })
  nearListeners.set(el, onChange)
  nearObserver.observe(el)
  return () => {
    nearListeners.delete(el)
    nearObserver?.unobserve(el)
  }
}

/**
 * Renders its children only while within a screen or so of the viewport,
 * holding `height` (theirs, known in advance) in the meantime, so the
 * scrollbar stays true. Without IntersectionObserver it always renders.
 */
function NearScreen({ height, children }: { height: number; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    return observeNear(el, setNear)
  }, [])
  return <div ref={ref} style={near ? undefined : { height }}>{near && children}</div>
}

/**
 * The changes view's strip under the header: the diff base (and a picker
 * for it), the shown files' line totals, overall and per stage, and what
 * the diff leaves out.
 */
function ChangesStrip({ workspaceId, projectId, baseBranch, data, files }: {
  workspaceId: string
  projectId: string
  baseBranch?: string
  data: WorkspaceChanges | undefined
  /** The changed files shown, whose lines are totalled. */
  files: WorkspaceChange[]
}): JSX.Element {
  const base = useUiStore((s) => s.changesBase[workspaceId])
  const setChangesBase = useUiStore((s) => s.setChangesBase)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const { data: branchData } = useProjectBranches(projectId, pickerOpen)
  // Always send an explicit base, even the workspace's own fork branch. The
  // server default reads the workspace's git config, which `git push -u`
  // repoints at the agent's own branch, making the diff empty.
  const pickBase = (branch: string): void => {
    setChangesBase(workspaceId, branch)
    setPickerOpen(false)
    setPickerQuery('')
  }
  const baseLabel = base ?? baseBranch ?? (data?.base ? data.base.slice(0, 7) : 'base')
  const byStage = stageTotals(files)
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-1.5 text-[11px] text-text-dim">
      <Popover.Root open={pickerOpen} onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}>
        <Popover.Trigger
          title="Choose the branch changes are compared against"
          className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none transition
            hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
        >
          <BranchIcon size={11} className="shrink-0 text-text-faint" />
          <span className="max-w-[180px] truncate font-mono text-text-dim">{baseLabel}</span>
          <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6}>
            <Popover.Popup className={clsx('w-[240px]', POPUP)}>
              <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">Diff base</div>
              <BranchPicker
                branches={branchData?.branches ?? []}
                defaultBranch={baseBranch}
                query={pickerQuery}
                onQueryChange={setPickerQuery}
                onSelect={pickBase}
                showList
                placeholder={branchData ? 'filter branches…' : 'loading branches…'}
                ariaLabel="Base branch"
                className="px-1 pb-1"
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {files.length > 0 && (
        // Baseline-aligned: the counts are monospace, the labels are not.
        <span className="flex shrink-0 items-baseline gap-1 text-text-faint">
          {[
            { key: 'total', label: 'total', counts: lineTotals(files) },
            ...CHANGE_STAGES.filter(({ stage }) => byStage[stage])
              .map(({ stage, label }) => ({ key: stage, label, counts: byStage[stage]! })),
          ].map(({ key, label, counts }, i) => (
            <Fragment key={key}>
              {i > 0 && <span aria-hidden className="px-0.5">·</span>}
              {label}
              <LineCountsLabel counts={counts} />
            </Fragment>
          ))}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {data && !data.baseResolved && files.length > 0 && (
          <span title="No fork point for the base branch, so only uncommitted work is shown." className="text-warning">
            uncommitted only
          </span>
        )}
        {data?.truncated && <span className="text-text-faint">diff truncated (large changeset)</span>}
      </div>
    </div>
  )
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
  if (isError) return <div className="px-3 py-0.5 text-[11px] text-text-faint">Couldn’t list this folder.</div>
  if (!data) return <div className="px-3 py-0.5 text-[11px] text-text-faint">Loading…</div>
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
      {data.truncated && <div className="px-3 py-0.5 text-[11px] text-text-faint">First 5,000 shown</div>}
    </>
  )
}

/** The inline name input: Enter commits, Escape cancels. */
function InlineInput({ initial, onCommit, onCancel }: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name up to its extension, so typing replaces just that.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Name"
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(e.currentTarget.value)
        else if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="w-full rounded border border-border-strong bg-bg px-1 py-0.5 text-xs text-text outline-none"
    />
  )
}
