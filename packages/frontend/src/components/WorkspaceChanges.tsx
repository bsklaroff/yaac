import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { paneViewKey, useUiStore } from '#lib/store'
import { CHANGES_TARGET, getWorkspaceChanges } from '#lib/changesApi'
import { getProjectBranches, projectBranchesKey } from '#lib/projectApi'
import { BranchPicker } from '#components/BranchPicker'
import { DiffView } from '#components/DiffView'
import { changeMatchesQuery, indexDiffsByPath, type ParsedFileDiff } from '#lib/diff'
import { languageForPath } from '#lib/highlight'
import { LoadingIcon, WarningIcon, ChevronIcon, BranchIcon, SearchIcon, OpenFileIcon } from '#lib/icons'
import { CHANGE_STATUS } from '#lib/gitStatus'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { chordMatches, findChord } from '#lib/shortcuts'
import { PathLabel } from '#components/ui/PathLabel'
import type { WorkspaceChange } from '@yaac/shared/types'

/**
 * The review pane: what the agent changed since forking from the base branch.
 * Files form an accordion; clicking one expands its diff inline. Polls the
 * server so it updates as work lands.
 */
export function WorkspaceChanges({ workspaceId, projectSlug, baseBranch, focusKey }: {
  workspaceId: string
  projectSlug: string
  baseBranch?: string
  /** Bumped when the pane is opened or cycled to, so it takes focus and
   *  Cmd/Ctrl-F works without the mouse. */
  focusKey?: number
}): JSX.Element {
  // The diff base: unset means the server's default fork base, otherwise
  // origin/<value>'s fork point. Stored per workspace to survive tab switches.
  const base = useUiStore((s) => s.changesBase[workspaceId])
  const setChangesBase = useUiStore((s) => s.setChangesBase)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['changes', workspaceId, base ?? null],
    queryFn: () => getWorkspaceChanges(workspaceId, base),
    refetchInterval: 3000,
    staleTime: 1500,
  })

  const files = useMemo(() => data?.files ?? [], [data?.files])
  const diffMap = useMemo(() => indexDiffsByPath(data?.diff ?? ''), [data?.diff])

  // View state (find query, expanded files, scroll) lives in the store per
  // workspace, so it survives the pane unmounting.
  const viewKey = paneViewKey(workspaceId, CHANGES_TARGET)
  const view = useUiStore((s) => s.paneView[viewKey])
  const setPaneView = useUiStore((s) => s.setPaneView)

  // The find query filters files by path or diff content. Cmd/Ctrl-F
  // (findChord) focuses it from anywhere in the pane.
  const find = view?.find ?? ''
  const setFind = (query: string): void => setPaneView(viewKey, { find: query })
  const findRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The root exists only once loading settles, hence isLoading in deps.
    const root = rootRef.current
    if (focusKey === undefined || !root || root.contains(document.activeElement) || dialogHoldsFocus()) return
    root.focus()
  }, [focusKey, isLoading])
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!chordMatches(findChord(), e.nativeEvent) || !findRef.current) return
    e.preventDefault()
    findRef.current.focus()
    findRef.current.select()
  }
  const visible = useMemo(
    () => files.filter((f) => changeMatchesQuery(f, diffMap.get(f.path), find)),
    [files, diffMap, find],
  )

  // Expanded files. With no stored entry yet, open the first file; after
  // that the set (even empty) is the user's choice.
  const expandedList = view?.expanded
  const expanded = useMemo(() => new Set(expandedList ?? []), [expandedList])
  useEffect(() => {
    if (expandedList === undefined && files.length > 0) {
      setPaneView(viewKey, { expanded: [files[0].path] })
    }
  }, [expandedList, files, viewKey, setPaneView])
  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPaneView(viewKey, { expanded: [...next] })
  }
  const openFile = useUiStore((s) => s.openFile)

  // Restore the saved scroll offset once on mount. The diff is cached, so
  // the content height is ready by layout time; the guard keeps later polls
  // from moving the scroll.
  const listRef = useRef<HTMLDivElement | null>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || restoredScroll.current) return
    restoredScroll.current = true
    el.scrollTop = useUiStore.getState().paneView[viewKey]?.scroll ?? 0
  }, [viewKey, files.length])

  // Base picker. Shares the branch cache (projectBranchesKey) with other
  // pickers; opening it refreshes from the remote in the background.
  const queryClient = useQueryClient()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const { data: branchData } = useQuery({
    queryKey: projectBranchesKey(projectSlug),
    queryFn: () => getProjectBranches(projectSlug),
    enabled: pickerOpen && projectSlug !== '',
  })
  useEffect(() => {
    if (!pickerOpen || !projectSlug) return
    getProjectBranches(projectSlug, { refresh: true })
      .then((fresh) => queryClient.setQueryData(projectBranchesKey(projectSlug), fresh))
      .catch(() => { /* stale-but-instant list stays */ })
  }, [pickerOpen, projectSlug, queryClient])

  // Always send an explicit base, even the workspace's own fork branch. The
  // server default reads the workspace's git config, which `git push -u`
  // repoints at the agent's own branch, making the diff empty.
  const pickBase = (branch: string): void => {
    setChangesBase(workspaceId, branch)
    setPickerOpen(false)
    setPickerQuery('')
  }
  const baseLabel = base ?? baseBranch ?? (data?.base ? data.base.slice(0, 7) : 'base')

  // Totals cover only the filtered files.
  const totals = visible.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-dim">
        <LoadingIcon size={18} className="animate-spin" />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <WarningIcon size={18} className="text-text-faint" />
        <span>Couldn’t load changes.</span>
        <button
          onClick={() => void refetch()}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    // Focusable so Cmd/Ctrl-F works after clicking in the pane.
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full flex-col bg-surface outline-none">
      {/* Always rendered so the base picker stays reachable when a base
          yields an empty diff. */}
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-2 text-[11px] text-text-dim">
        <Popover.Root
          open={pickerOpen}
          onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}
        >
          <Popover.Trigger
            title="Choose the branch this diff is compared against"
            className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none transition
              hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
          >
            <BranchIcon size={11} className="shrink-0 text-text-faint" />
            <span className="max-w-[180px] truncate font-mono text-text-dim">{baseLabel}</span>
            <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={6}>
              <Popover.Popup
                className="w-[240px] rounded-lg border border-border bg-surface-2 p-1 text-text
                  shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
                  data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
              >
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

        {files.length > 0 ? (
          <>
            <span>
              {find !== ''
                ? `${visible.length} of ${files.length} files`
                : `${files.length} file${files.length === 1 ? '' : 's'}`}
            </span>
            <span className="text-success">+{totals.add}</span>
            <span className="text-error">−{totals.del}</span>
          </>
        ) : (
          // Without a resolved fork point, committed work is not in the diff.
          <span className="text-text-faint">{data && !data.baseResolved ? 'nothing uncommitted' : 'no changes'}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {data && !data.baseResolved && files.length > 0 && (
            <span title="No fork point for the base branch — only uncommitted work is shown." className="text-warning">
              uncommitted only
            </span>
          )}
          {data?.truncated && (
            <span className="text-text-faint">diff truncated (large changeset)</span>
          )}
          <SearchIcon size={11} className="shrink-0 text-text-faint" />
          <input
            ref={findRef}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              if (find !== '') setFind('')
              else e.currentTarget.blur()
            }}
            placeholder="find"
            aria-label="Find in changes"
            spellCheck={false}
            className="w-28 rounded bg-transparent px-1 py-0.5 text-[11px] text-text outline-none
              transition placeholder:text-text-faint focus:bg-surface-2"
          />
        </div>
      </div>

      {files.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          {/* An unresolved base means the diff ran against HEAD and misses
              committed work, so name the missing branch instead. */}
          {data && !data.baseResolved ? (
            <>
              <p className="text-xs text-text-dim">Nothing uncommitted</p>
              <p className="text-[11px] text-text-faint">
                Couldn’t find the fork point for “{baseLabel}”, so committed work isn’t shown.
                Push that branch, or pick another base above.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-text-dim">No changes yet</p>
              <p className="text-[11px] text-text-faint">Edits the agent makes in its workspace show up here.</p>
            </>
          )}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <p className="text-xs text-text-dim">No files match “{find}”</p>
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={(e) => setPaneView(viewKey, { scroll: e.currentTarget.scrollTop })}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {visible.map((f) => (
            <FileAccordion
              key={f.path}
              file={f}
              open={expanded.has(f.path)}
              diff={diffMap.get(f.path)}
              onToggle={() => toggle(f.path)}
              onOpen={() => openFile(workspaceId, f.path)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FileAccordion({
  file, open, diff, onToggle, onOpen,
}: {
  file: WorkspaceChange
  open: boolean
  diff: ParsedFileDiff | undefined
  onToggle: () => void
  /** Open the file in an editor pane. */
  onOpen: () => void
}): JSX.Element {
  const meta = CHANGE_STATUS[file.status]
  // Renames/copies show `old → new`; git only sets oldPath for those.
  const renamedFrom = file.oldPath && file.oldPath !== file.path ? file.oldPath : undefined
  return (
    <div className="group/row relative border-b border-hairline">
      <button
        onClick={onToggle}
        title={renamedFrom ? `${renamedFrom} → ${file.path}` : file.path}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-text-dim
          transition hover:bg-surface-2"
      >
        <ChevronIcon size={12} className={clsx('shrink-0 text-text-faint transition-transform', open && 'rotate-90')} />
        <span className={clsx('w-2 shrink-0 text-center font-mono font-semibold', meta.className)}>{meta.letter}</span>
        <span className="min-w-0 flex-1 truncate">
          {renamedFrom && (
            <>
              <PathLabel path={renamedFrom} emphasis="dim" />
              <span className="text-text-faint"> → </span>
            </>
          )}
          <PathLabel path={file.path} />
        </span>
        {file.status !== 'deleted' && <span className="w-5 shrink-0" />}
        {!file.binary && (
          <span className="shrink-0 font-mono text-[10px] text-text-faint">
            {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-error">−{file.deletions}</span>}
          </span>
        )}
      </button>
      {file.status !== 'deleted' && (
        <button
          onClick={onOpen}
          title="Open file"
          aria-label={`Open ${file.path}`}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded text-text-faint
            opacity-0 transition hover:bg-surface-3 hover:text-text group-hover/row:opacity-100 max-md:opacity-100"
        >
          <OpenFileIcon size={11} />
        </button>
      )}
      {open && (
        <div className="overflow-x-auto border-t border-hairline bg-bg">
          {diff && !diff.binary && diff.lines.length > 0 ? (
            <DiffView lines={diff.lines} language={languageForPath(file.path)} />
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-faint">
              {file.binary ? 'Binary file — no preview' : 'No textual diff'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


