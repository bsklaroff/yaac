import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import type { FileStatus, SymlinkTarget } from '@yaac/shared/types'
import { paneViewKey, useUiStore } from '#store'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { PathLabel } from '#components/ui/PathLabel'
import { FILE_STATUS } from '#lib/gitStatus'
import { paneTargets } from '#lib/layout'
import {
  FILES_TARGET,
  FileConflict,
  buildTree,
  countFiles,
  createWorktreeFolder,
  deleteWorktreeEntry,
  discardFileSavers,
  fileKey,
  fileTargetPath,
  filterPaths,
  flushFileSavers,
  isFileTarget,
  listWorktreeDir,
  listWorktreeFiles,
  renameWorktreeEntry,
  saveWorktreeFile,
  type TreeNode,
} from '#lib/files'
import {
  ChevronIcon, FileIcon, FolderIcon, FolderOpenIcon, HideIcon, LoadingIcon, MoreIcon, NewFileIcon,
  NewFolderIcon, SearchIcon, ShowIcon, SymlinkIcon, WarningIcon,
} from '#lib/icons'

/** The most matches the filter lists. */
const MAX_MATCHES = 200

/**
 * One row of the tree. `path` is the path as displayed — under a folder
 * link it runs through the link, and that is what opening it sends: the
 * server follows the link.
 */
interface Row {
  path: string
  name: string
  dir: boolean
  node?: TreeNode
  ignored: boolean
  status?: FileStatus
  symlink?: SymlinkTarget
}

function rowOf(node: TreeNode, path: string, ignored: boolean): Row {
  return {
    path, name: node.name, dir: node.dir, node,
    ignored: ignored || node.ignored === true, status: node.status, symlink: node.symlink,
  }
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const join = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Editing =
  | { kind: 'file' | 'folder'; parent: string }
  | { kind: 'rename'; path: string }

/**
 * The file explorer (docs/file-editor.md): a worktree's files as a tree
 * built from one gitignore-aware listing, a filter that doubles as
 * quick-open, a "show ignored" toggle, git status colors, and create /
 * rename / delete through an inline input and a context menu. Ephemeral like
 * Changes — torn down off-screen, so a hidden explorer lists nothing — with
 * its view state kept in the store.
 */
export function WorktreeFiles({ worktreeId }: { worktreeId: string }): JSX.Element {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['files', worktreeId],
    queryFn: () => listWorktreeFiles(worktreeId),
    refetchInterval: 5000,
  })
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['files', worktreeId] }) }

  const viewKey = paneViewKey(worktreeId, FILES_TARGET)
  const view = useUiStore((s) => s.paneView[viewKey])
  const setPaneView = useUiStore((s) => s.setPaneView)
  const openFile = useUiStore((s) => s.openFile)
  const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded])
  const showIgnored = view?.showIgnored === true
  const find = view?.find ?? ''
  const setExpanded = (paths: Set<string>): void => setPaneView(viewKey, { expanded: [...paths] })
  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setExpanded(next)
  }

  const tree = useMemo(() => (data ? buildTree(data, showIgnored) : null), [data, showIgnored])
  const searchable = useMemo(() => (data
    ? [...data.paths, ...(showIgnored ? data.ignored.filter((p) => !p.endsWith('/')) : [])]
    : []), [data, showIgnored])
  const matches = useMemo(() => (find ? filterPaths(searchable, find, MAX_MATCHES) : []), [searchable, find])
  const ignoredFiles = useMemo(() => new Set(data?.ignored ?? []), [data?.ignored])

  // The open-files shortcut raises filesFindPending after opening the pane; the
  // mounted pane consumes it by focusing its filter, which makes Alt-E, a
  // few letters and Enter a quick-open.
  const findPending = useUiStore((s) => s.filesFindPending)
  const setFindPending = useUiStore((s) => s.setFilesFindPending)
  const findRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!findPending || !findRef.current) return
    setFindPending(false)
    findRef.current.focus()
    findRef.current.select()
  }, [findPending, isLoading, setFindPending])

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
    const layout = worktreeId in state.layouts ? state.layouts[worktreeId] : null
    return paneTargets(layout).filter(isFileTarget).map(fileTargetPath)
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
        // The panes showing it remount under the new path, which would drop
        // any text they have not saved — so that text lands first.
        const affected = openUnder(editing.path)
        if (!(await flushFileSavers(affected.map((p) => fileKey(worktreeId, p))))) {
          setEditError('Resolve unsaved changes first.')
          return
        }
        await renameWorktreeEntry(worktreeId, editing.path, to)
        useUiStore.getState().renameFiles(worktreeId, editing.path, to)
      } else {
        const path = join(editing.parent, name)
        if (editing.kind === 'folder') {
          await createWorktreeFolder(worktreeId, path)
        } else {
          await saveWorktreeFile(worktreeId, path, '', null)
          openFile(worktreeId, path)
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
    // What the affected panes hold goes with the files — the confirm said so
    // — and a pending autosave must not run after the delete: it would only
    // be refused, but it has no business trying.
    discardFileSavers(affected.map((p) => fileKey(worktreeId, p)))
    try {
      await deleteWorktreeEntry(worktreeId, row.path)
      useUiStore.getState().closeFiles(worktreeId, affected)
      if (selected?.path === row.path) setSelected(null)
      refresh()
    } catch (e) {
      setActionError(errMessage(e))
    }
  }

  const deleteText = (row: Row): { title: string; description: string } => {
    const dirty = useUiStore.getState().dirtyFiles
    const unsaved = openUnder(row.path).filter((p) => dirty[fileKey(worktreeId, p)])
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
    const ITEM = 'flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-dim '
      + 'outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'
    const folder = row === null ? '' : row.dir && !row.symlink ? row.path : null
    return (
      <>
        {folder !== null && (
          <>
            <Item className={ITEM} onClick={() => startEdit({ kind: 'file', parent: folder })}>
              <NewFileIcon size={13} /> New file
            </Item>
            <Item className={ITEM} onClick={() => startEdit({ kind: 'folder', parent: folder })}>
              <NewFolderIcon size={13} /> New folder
            </Item>
          </>
        )}
        {row !== null && (
          <>
            <Item className={ITEM} onClick={() => startEdit({ kind: 'rename', path: row.path })}>Rename</Item>
            <Item className={ITEM} onClick={() => setConfirmDelete(row)}>Delete</Item>
          </>
        )}
      </>
    )
  }
  const POPUP = 'min-w-[160px] rounded-lg border border-border bg-surface-2 p-1 text-text '
    + 'shadow-[0_12px_32px_var(--shadow-color)] outline-none'

  // ── rendering ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-dim">
        <LoadingIcon size={18} className="animate-spin" />
      </div>
    )
  }
  if (isError || !data || !tree) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <WarningIcon size={18} className="text-text-faint" />
        <span>Couldn’t load files.</span>
        <button
          onClick={() => void refetch()}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
        >
          Retry
        </button>
      </div>
    )
  }

  const input = (initial: string, depth: number): JSX.Element => (
    <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 pr-2">
      <InlineInput
        initial={initial}
        onCommit={(v) => void commitEdit(v)}
        onCancel={() => { setEditing(null); setEditError(null) }}
      />
      {editError && <div className="py-0.5 text-[11px] text-[#f85149]">{editError}</div>}
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
      {rows.map((row) => (
        <TreeRowView
          key={row.path}
          row={row}
          depth={depth}
          open={expanded.has(row.path)}
          selected={selected?.path === row.path}
          renaming={editing?.kind === 'rename' && editing.path === row.path}
          renameInput={input(row.name, depth)}
          onClick={() => {
            setSelected(row)
            if (row.dir) toggle(row.path)
            else if (!row.symlink || row.symlink.target !== null) openFile(worktreeId, row.path)
          }}
          onContextMenu={() => setContextRow(row)}
          onMore={(anchor) => setMenu({ row, anchor })}
        >
          {row.dir && expanded.has(row.path) && ((): JSX.Element => {
            const children = childRows(row)
            return children === 'lazy'
              ? <LazyRows worktreeId={worktreeId} parent={row} render={(rs) => renderRows(rs, depth + 1, row.path)} />
              : renderRows(children, depth + 1, row.path)
          })()}
        </TreeRowView>
      ))}
    </>
  )

  const header = (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-hairline px-2 text-[11px] text-text-dim">
      <span className="shrink-0">
        {find ? `${matches.length}${matches.length === MAX_MATCHES ? '+' : ''} of ${data.paths.length}` : `${data.paths.length} files`}
      </span>
      {data.truncated && <span className="shrink-0 text-text-faint" title="Only the first 50,000 paths are listed.">truncated</span>}
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        <SearchIcon size={11} className="shrink-0 text-text-faint" />
        <input
          ref={findRef}
          value={find}
          onChange={(e) => setPaneView(viewKey, { find: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              e.preventDefault()
              openFile(worktreeId, matches[0])
              return
            }
            if (e.key !== 'Escape') return
            // First Escape clears the filter, a second one leaves the box.
            e.stopPropagation()
            if (find !== '') setPaneView(viewKey, { find: '' })
            else e.currentTarget.blur()
          }}
          placeholder="go to file"
          aria-label="Filter files"
          spellCheck={false}
          className="w-24 min-w-0 rounded bg-transparent px-1 py-0.5 text-[11px] text-text outline-none
            transition placeholder:text-text-faint focus:bg-surface-2"
        />
        <HeaderButton
          label={showIgnored ? 'Hide ignored files' : 'Show ignored files'}
          pressed={showIgnored}
          onClick={() => setPaneView(viewKey, { showIgnored: !showIgnored })}
        >
          {showIgnored ? <ShowIcon size={12} /> : <HideIcon size={12} />}
        </HeaderButton>
        <HeaderButton label="New file" onClick={() => startEdit({ kind: 'file', parent: createParent() })}>
          <NewFileIcon size={12} />
        </HeaderButton>
        <HeaderButton label="New folder" onClick={() => startEdit({ kind: 'folder', parent: createParent() })}>
          <NewFolderIcon size={12} />
        </HeaderButton>
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col bg-surface">
      {header}
      {actionError && (
        <div role="alert" className="shrink-0 border-b border-hairline px-2 py-1 text-[11px] text-[#f85149]">
          {actionError}
        </div>
      )}
      {find ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
          {matches.length === 0 && <p className="px-3 py-2 text-xs text-text-dim">No files match “{find}”</p>}
          {matches.map((path) => {
            const status = data.status[path]
            const ignored = ignoredFiles.has(path)
            return (
              <button
                key={path}
                onClick={() => openFile(worktreeId, path)}
                title={path}
                className={clsx('flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs hover:bg-surface-2',
                  ignored && 'opacity-50')}
              >
                <span className="min-w-0 flex-1 truncate">
                  <PathLabel path={path} baseClassName={status ? FILE_STATUS[status].className : undefined} />
                </span>
                {status && <StatusBadge status={status} />}
              </button>
            )
          })}
        </div>
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger
            ref={listRef}
            onContextMenuCapture={() => setContextRow(null)}
            // A click on empty space clears the selection, so the header's
            // New file / New folder land at the root again.
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }}
            onScroll={(e) => setPaneView(viewKey, { scroll: e.currentTarget.scrollTop })}
            className="min-h-0 flex-1 overflow-y-auto py-0.5"
          >
            {renderRows(tree.root.children.map((c) => rowOf(c, c.name, false)), 0, '')}
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner>
              <ContextMenu.Popup className={POPUP}>{menuItems(contextRow, ContextMenu.Item)}</ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}

      <Menu.Root open={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null) }}>
        <Menu.Portal>
          <Menu.Positioner anchor={menu?.anchor} side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className={POPUP}>{menu && menuItems(menu.row, Menu.Item)}</Menu.Popup>
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
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:bg-surface-2 hover:text-text',
        pressed ? 'text-text' : 'text-text-faint')}
    >
      {children}
    </button>
  )
}

function StatusBadge({ status }: { status: FileStatus }): JSX.Element {
  const meta = FILE_STATUS[status]
  return <span className={clsx('w-3 shrink-0 text-center font-mono text-[10px] font-semibold', meta.className)}>{meta.letter}</span>
}

function TreeRowView({
  row, depth, open, selected, renaming, renameInput, onClick, onContextMenu, onMore, children,
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
  children?: ReactNode
}): JSX.Element {
  const broken = row.symlink !== undefined && row.symlink.target === null
  const meta = row.status && !row.ignored ? FILE_STATUS[row.status] : undefined
  const Icon = row.dir ? (open ? FolderOpenIcon : FolderIcon) : FileIcon
  return (
    <>
      {renaming ? renameInput : (
        <div
          className={clsx('group/row relative flex items-center', selected && 'bg-surface-2')}
          onContextMenu={onContextMenu}
        >
          <button
            onClick={onClick}
            title={broken ? `${row.path} — broken link, or points outside the worktree` : row.path}
            aria-expanded={row.dir ? open : undefined}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={clsx('flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-7 text-left text-xs hover:bg-surface-2',
              (row.ignored || broken) && 'opacity-50', broken && 'cursor-default')}
          >
            <ChevronIcon
              size={11}
              className={clsx('shrink-0 text-text-faint transition-transform', !row.dir && 'invisible', open && 'rotate-90')}
            />
            <Icon size={12} className="shrink-0 text-text-faint" />
            <span className={clsx('min-w-0 truncate', meta?.className ?? (row.dir ? 'text-text-dim' : 'text-text'))}>
              {row.name}
            </span>
            {row.symlink && <SymlinkIcon size={11} aria-label="symlink" className="shrink-0 text-text-faint" />}
            <span className="ml-auto" />
            {meta && (row.dir
              ? <span aria-label={row.status} className={clsx('shrink-0 text-[9px]', meta.className)}>●</span>
              : <StatusBadge status={row.status!} />)}
          </button>
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
      {children}
    </>
  )
}

/** The children of a folder the listing leaves out — an ignored one, or a
 *  link into one — fetched when it is first expanded. */
function LazyRows({ worktreeId, parent, render }: {
  worktreeId: string
  parent: Row
  render: (rows: Row[]) => JSX.Element
}): JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['dir', worktreeId, parent.path],
    queryFn: () => listWorktreeDir(worktreeId, parent.path),
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
