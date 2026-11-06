import { Fragment, useState, type JSX } from 'react'
import { Popover } from '@base-ui/react/popover'
import { WORKTREE_REF, type CommitDetail, type WorkspaceChange, type WorkspaceDiff } from '@yaac/shared/types'
import { PopoverPopup } from '#components/ui/menu'
import { LineCountsLabel } from '#components/ui/LineCountsLabel'
import { Typeahead, type TypeaheadItem } from '#components/ui/Typeahead'
import { isCommit, refName } from '#lib/commits'
import { changesTarget, type ChangesRange } from '#lib/files'
import { CHANGE_STAGES, lineTotals, stageTotals } from '#lib/gitStatus'
import { RangeArrowIcon, BranchIcon, ChevronIcon, CommitsIcon, FileIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useProjectBranches } from '#lib/useProjectBranches'

/** A typed commit id (or a prefix of one) the ref pickers offer as is. */
const COMMIT_PREFIX = /^[0-9a-f]{7,64}$/
/** The start picker's item for no start: one commit against its parent.
 *  `:` cannot appear in a ref name. */
const PARENT = ':parent'

/**
 * The Changes pane's strip under the header: what it compares, the shown
 * files' line totals, overall and per stage, and what the diff leaves out.
 * The workspace's own pane names its base and offers to compare something
 * else; a range's pane picks either end, which retargets it in place
 * (`retargetRange`), and leads back to the workspace's own.
 */
export function ChangesStrip({ workspaceId, projectId, baseBranch, startCommit, range, data, files }: {
  workspaceId: string
  projectId: string
  baseBranch?: string
  startCommit?: string
  range?: ChangesRange
  data: WorkspaceDiff | undefined
  /** The changed files shown, whose lines are totalled. */
  files: WorkspaceChange[]
}): JSX.Element {
  const openRange = useUiStore((s) => s.openRange)
  const openChanges = useUiStore((s) => s.openChanges)
  const retargetRange = useUiStore((s) => s.retargetRange)
  const base = baseBranch ?? startCommit
  const retarget = (next: ChangesRange): void => {
    if (range) retargetRange(workspaceId, changesTarget(range), changesTarget(next))
  }
  const byStage = stageTotals(files)
  const action = 'shrink-0 rounded px-1.5 py-0.5 transition hover:bg-surface-2 hover:text-text'
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-hairline px-1.5 text-[11px] text-text-dim">
      {range ? (
        <>
          <RefPicker
            projectId={projectId}
            value={range.from}
            ariaLabel="Compare from"
            parent={range.to !== WORKTREE_REF}
            onPick={(from) => retarget(from === PARENT ? { to: range.to } : { from, to: range.to })}
          />
          <RangeArrowIcon size={11} className="shrink-0 text-text-faint" />
          <RefPicker
            projectId={projectId}
            value={range.to}
            ariaLabel="Compare to"
            worktree
            onPick={(to) => retarget({ ...range, to })}
          />
        </>
      ) : (
        <span title="The branch changes are compared against" className="flex min-w-0 items-center gap-1 px-1.5">
          <RefIcon value={baseBranch ?? startCommit} />
          <span className="max-w-[180px] truncate font-mono">
            {baseBranch !== undefined ? `origin/${baseBranch}` : startCommit !== undefined ? refName(startCommit) : 'base'}
          </span>
        </span>
      )}
      {files.length > 0 && (
        // Baseline-aligned: the counts are monospace, the labels are not.
        <span className="ml-1 flex shrink-0 items-baseline gap-1 text-text-faint">
          {[
            { key: 'total', label: 'total', counts: lineTotals(files) },
            ...range ? [] : CHANGE_STAGES.filter(({ stage }) => byStage[stage])
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
        {range ? (
          <button onClick={() => openChanges(workspaceId)} title="The workspace's own changes" className={action}>
            Review diff
          </button>
        ) : (
          <button
            onClick={() => openRange(workspaceId, { from: base ?? 'HEAD', to: WORKTREE_REF })}
            title="Compare any two branches or commits"
            className={action}
          >
            Compare…
          </button>
        )}
      </div>
    </div>
  )
}

function RefIcon({ value }: { value?: string }): JSX.Element {
  const Icon = value === WORKTREE_REF ? FileIcon : value !== undefined && (isCommit(value) || value === 'HEAD')
    ? CommitsIcon : BranchIcon
  return <Icon size={11} className="shrink-0 text-text-faint" />
}

/**
 * One end of a range: origin's branches (by name, as the server tries
 * `origin/<name>` first), HEAD, the working tree when `worktree`, `PARENT`
 * when `parent`, or a commit id typed into the filter. An unset `value` is a
 * single commit's parent.
 */
function RefPicker({ projectId, value, ariaLabel, worktree = false, parent = false, onPick }: {
  projectId: string
  value?: string
  ariaLabel: string
  worktree?: boolean
  parent?: boolean
  onPick: (ref: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listed = useProjectBranches(projectId, open)
  const typed = query.trim()
  const items: TypeaheadItem[] = [
    ...worktree ? [{ value: WORKTREE_REF, label: 'Working tree', detail: 'with uncommitted work' }] : [],
    ...parent && value !== undefined ? [{ value: PARENT, label: 'Parent', detail: 'show one commit' }] : [],
    { value: 'HEAD', label: 'HEAD', detail: 'committed only' },
    ...(listed.data?.branches ?? []).map((b) => ({ value: b, label: b })),
    ...COMMIT_PREFIX.test(typed) ? [{ value: typed, label: typed, detail: 'commit' }] : [],
  ]
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
      <Popover.Trigger
        title={ariaLabel}
        className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none transition
          hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
      >
        <RefIcon value={value} />
        <span className="max-w-[160px] truncate font-mono">{value === undefined ? 'parent' : refName(value)}</span>
        <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
      </Popover.Trigger>
      <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-[260px]">
        <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">{ariaLabel}</div>
        <Typeahead
          items={items}
          query={query}
          onQueryChange={setQuery}
          onSelect={(ref) => {
            setOpen(false)
            setQuery('')
            if (ref !== value) onPick(ref)
          }}
          showList
          placeholder="branch, HEAD or commit id…"
          ariaLabel={ariaLabel}
          className="px-1 pb-1"
        />
      </PopoverPopup>
    </Popover.Root>
  )
}

/** A single commit's pane heads its diff with the commit, as `git show`
 *  does; its parents open their own. */
export function CommitHeader({ workspaceId, commit }: { workspaceId: string; commit: CommitDetail }): JSX.Element {
  const openRange = useUiStore((s) => s.openRange)
  const newline = commit.message.indexOf('\n')
  const subject = newline === -1 ? commit.message : commit.message.slice(0, newline)
  const body = newline === -1 ? '' : commit.message.slice(newline + 1).replace(/^\n+/, '')
  const when = new Date(commit.time * 1000)
  return (
    <div className="max-h-48 shrink-0 overflow-auto border-b border-hairline px-3 py-2 text-xs">
      <div className="font-medium text-text">{subject}</div>
      {body && <div className="mt-1 whitespace-pre-wrap text-text-dim">{body}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-faint">
        <span>{commit.author}</span>
        <span title={when.toLocaleString()}>{relativeAge(when.toISOString())}</span>
        <span className="select-all font-mono" title={commit.sha}>{commit.sha.slice(0, 7)}</span>
        {commit.parents.length > 0 && (
          <span className="flex items-center gap-1">
            {commit.parents.length > 1 ? 'parents' : 'parent'}
            {commit.parents.map((p) => (
              <button
                key={p}
                onClick={() => openRange(workspaceId, { to: p })}
                title={`Show ${p}`}
                className="font-mono text-link hover:underline"
              >
                {p.slice(0, 7)}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
