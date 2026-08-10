import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { useUiStore } from '#store'
import { getWorktreeChanges } from '#lib/changesApi'
import { getProjectBranches, projectBranchesKey } from '#lib/projectApi'
import { BranchPicker } from '#components/BranchPicker'
import { DiffView } from '#components/DiffView'
import { changeMatchesQuery, indexDiffsByPath, type ParsedFileDiff } from '#lib/diff'
import { languageForPath } from '#lib/highlight'
import { LoadingIcon, WarningIcon, ChevronIcon, BranchIcon, SearchIcon } from '#lib/icons'
import type { ChangeStatus, WorktreeChange } from '@yaac/shared/types'

/** One-letter status badge, colored per change kind. */
const STATUS_META: Record<ChangeStatus, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-[#3fb950]' },
  modified: { letter: 'M', className: 'text-[#d29922]' },
  deleted: { letter: 'D', className: 'text-[#f85149]' },
  renamed: { letter: 'R', className: 'text-[#58a6ff]' },
  copied: { letter: 'C', className: 'text-[#58a6ff]' },
  typechange: { letter: 'T', className: 'text-text-dim' },
}

/** Split a path into directory + basename for two-tone rendering. */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

/** Render a path as a faint directory prefix + a basename; `emphasis="dim"`
 *  mutes the basename (used for the "from" side of a rename). */
function PathLabel({ path, emphasis = 'text' }: { path: string; emphasis?: 'text' | 'dim' }): JSX.Element {
  const { dir, base } = splitPath(path)
  return (
    <>
      {dir && <span className="text-text-faint">{dir}</span>}
      <span className={emphasis === 'dim' ? 'text-text-dim' : 'text-text'}>{base}</span>
    </>
  )
}

/**
 * The worktree review pane: what the agent changed in its worktree since it
 * forked from the base branch. Files are an accordion — click one to expand
 * its diff inline (full width), so nothing is wasted on a side column. Polls
 * the server so it updates as work lands; read-only for now.
 */
export function WorktreeChanges(
  { worktreeId, projectSlug, baseBranch }: { worktreeId: string; projectSlug: string; baseBranch?: string },
): JSX.Element {
  // The base branch this diff is compared against. Absent ⇒ the worktree's own
  // fork base (server default); a value ⇒ diff against origin/<value>'s fork
  // point. Lives in the store keyed by worktree id, so it survives a tab switch.
  const base = useUiStore((s) => s.changesBase[worktreeId])
  const setChangesBase = useUiStore((s) => s.setChangesBase)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['changes', worktreeId, base ?? null],
    queryFn: () => getWorktreeChanges(worktreeId, base),
    refetchInterval: 3000,
    staleTime: 1500,
  })

  const files = useMemo(() => data?.files ?? [], [data?.files])
  const diffMap = useMemo(() => indexDiffsByPath(data?.diff ?? ''), [data?.diff])

  // Find. The query filters the file list by path or diff content; it lives in
  // the store keyed by worktree id (like the expanded set) so it survives the
  // pane being torn down on a tab or worktree switch. The find-changes shortcut
  // raises changesFindPending after opening the pane; the mounted pane consumes
  // it — focus + select the input — so opening by the header button (no flag)
  // never grabs focus.
  const find = useUiStore((s) => s.changesFind[worktreeId]) ?? ''
  const setChangesFind = useUiStore((s) => s.setChangesFind)
  const findPending = useUiStore((s) => s.changesFindPending)
  const setChangesFindPending = useUiStore((s) => s.setChangesFindPending)
  const findRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    // The input only exists once loading settles (the spinner/error branches
    // return early below), so leave the flag pending until it's mounted —
    // isLoading in the deps re-runs this when the data arrives.
    if (!findPending || !findRef.current) return
    setChangesFindPending(false)
    findRef.current.focus()
    findRef.current.select()
  }, [findPending, isLoading, setChangesFindPending])
  const visible = useMemo(
    () => files.filter((f) => changeMatchesQuery(f, diffMap.get(f.path), find)),
    [files, diffMap, find],
  )

  // Which files are expanded. This lives in the store keyed by worktree id, not
  // in local state, so it survives the pane being torn down off-screen when the
  // user switches tabs or worktrees. A missing entry means we haven't loaded
  // this worktree's changes yet: auto-open the first file so the pane isn't
  // empty on arrival, then leave it to the user — an existing entry (even an
  // empty one) is their choice and never gets re-seeded.
  const expandedList = useUiStore((s) => s.changesExpanded[worktreeId])
  const setChangesExpanded = useUiStore((s) => s.setChangesExpanded)
  const expanded = useMemo(() => new Set(expandedList ?? []), [expandedList])
  useEffect(() => {
    if (expandedList === undefined && files.length > 0) {
      setChangesExpanded(worktreeId, [files[0].path])
    }
  }, [expandedList, files, worktreeId, setChangesExpanded])
  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChangesExpanded(worktreeId, [...next])
  }

  // Scroll offset also lives in the store, so returning to the pane lands where
  // the user left off. On remount the diff is already cached and the expanded
  // state is applied synchronously, so the content height is present by layout
  // time; restore once (guarded), then let the user drive. Later polls that
  // don't change the file list won't re-run this — and if they do, the guard
  // keeps us from yanking the scroll out from under the user.
  const setChangesScroll = useUiStore((s) => s.setChangesScroll)
  const listRef = useRef<HTMLDivElement | null>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || restoredScroll.current) return
    restoredScroll.current = true
    el.scrollTop = useUiStore.getState().changesScroll[worktreeId] ?? 0
  }, [worktreeId, files.length])

  // Base picker. It shares the sidebar's branch cache (projectBranchesKey), so a
  // refresh in either place is seen by both; opening it refreshes from the
  // remote in the background, exactly like the new-worktree popover.
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

  // Every pick is sent as an explicit base, including the worktree's own fork
  // branch. Clearing it instead would fall back to the server's default base,
  // which is read live from the worktree's git config — and an agent that
  // pushes with `git push -u` rewrites that to its own remote branch, whose
  // fork point is HEAD ("No changes"). An explicit base always diffs against
  // origin/<branch>, which is what the label promises.
  const pickBase = (branch: string): void => {
    setChangesBase(worktreeId, branch)
    setPickerOpen(false)
    setPickerQuery('')
  }
  // Prefer a human branch name; fall back to a short SHA only when neither the
  // override nor the worktree's tracked branch is known.
  const baseLabel = base ?? baseBranch ?? (data?.base ? data.base.slice(0, 7) : 'base')

  // Totals follow the filter, so the header always describes the listed files.
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
    <div className="flex h-full flex-col bg-surface">
      {/* Header is always present (even with no changes) so the base picker
          stays reachable — otherwise a base that yields an empty diff would
          trap the user with no way to switch back. */}
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
            <span className="text-[#3fb950]">+{totals.add}</span>
            <span className="text-[#f85149]">−{totals.del}</span>
          </>
        ) : (
          // Only "no changes" when the fork point actually resolved — otherwise
          // committed work simply wasn't in the diff to begin with.
          <span className="text-text-faint">{data && !data.baseResolved ? 'nothing uncommitted' : 'no changes'}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {data && !data.baseResolved && files.length > 0 && (
            <span title="No fork point for the base branch — only uncommitted work is shown." className="text-[#d29922]">
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
            onChange={(e) => setChangesFind(worktreeId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // First Escape clears the filter, a second one leaves the box.
              e.stopPropagation()
              if (find !== '') setChangesFind(worktreeId, '')
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
          {/* An unresolved base means the diff ran against HEAD, so committed
              work is missing from it — claiming "no changes" there is a lie.
              Name the branch we couldn't find instead, so the fix (push it, or
              pick another base) is obvious. */}
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
              <p className="text-[11px] text-text-faint">Edits the agent makes in its worktree show up here.</p>
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
          onScroll={(e) => setChangesScroll(worktreeId, e.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {visible.map((f) => (
            <FileAccordion
              key={f.path}
              file={f}
              open={expanded.has(f.path)}
              diff={diffMap.get(f.path)}
              onToggle={() => toggle(f.path)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FileAccordion({
  file, open, diff, onToggle,
}: {
  file: WorktreeChange
  open: boolean
  diff: ParsedFileDiff | undefined
  onToggle: () => void
}): JSX.Element {
  const meta = STATUS_META[file.status]
  // Renames/copies show `old → new`; git only sets oldPath for those.
  const renamedFrom = file.oldPath && file.oldPath !== file.path ? file.oldPath : undefined
  return (
    <div className="border-b border-hairline">
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
        {!file.binary && (
          <span className="shrink-0 font-mono text-[10px] text-text-faint">
            {file.additions > 0 && <span className="text-[#3fb950]">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-[#f85149]">−{file.deletions}</span>}
          </span>
        )}
      </button>
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


