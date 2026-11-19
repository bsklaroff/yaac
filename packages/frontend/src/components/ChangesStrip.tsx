import { Fragment, useState, type JSX } from 'react'
import { WORKTREE_REF, type CommitDetail, type WorkspaceChange, type WorkspaceDiff } from '@yaac/shared/types'
import { LineCountsLabel } from '#components/LineCountsLabel'
import { isCommit, refName } from '#lib/commits'
import { changesTarget, type ChangesRange } from '#lib/files'
import { CHANGE_STAGES, lineTotals, stageTotals } from '#lib/gitStatus'
import { RangeArrowIcon, BranchIcon, CommitsIcon, FileIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useRepoBranches } from '#lib/repoApi'
import { useCheckout } from '#lib/checkouts'
import { CheckoutSwitcher } from '#components/CheckoutSwitcher'
import { YButton, YChip, YPopover, YPopoverPopup, YTypeahead, type YTypeaheadItem } from '#ui'

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
 * (`retargetRange`), and leads back to the workspace's own. Both describe
 * the checkout the workspace's switcher picks (`useCheckout`).
 */
export function ChangesStrip({ workspaceId, range, data, files }: {
  workspaceId: string
  range?: ChangesRange
  data: WorkspaceDiff | undefined
  /** The changed files shown, whose lines are totalled. */
  files: WorkspaceChange[]
}): JSX.Element {
  const openRange = useUiStore((s) => s.openRange)
  const openChanges = useUiStore((s) => s.openChanges)
  const retargetRange = useUiStore((s) => s.retargetRange)
  const { current } = useCheckout(workspaceId)
  const repoId = current?.repoId ?? ''
  const baseBranch = current?.baseBranch
  const startCommit = current?.startCommit
  const base = baseBranch ?? startCommit
  const retarget = (next: ChangesRange): void => {
    if (range) retargetRange(workspaceId, changesTarget(range), changesTarget(next))
  }
  const byStage = stageTotals(files)
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-1.5 text-sm text-muted">
      <CheckoutSwitcher workspaceId={workspaceId} />
      {range ? (
        <>
          <RefPicker
            repoId={repoId}
            value={range.from}
            ariaLabel="Compare from"
            parent={range.to !== WORKTREE_REF}
            onPick={(from) => retarget(from === PARENT ? { to: range.to } : { from, to: range.to })}
          />
          <RangeArrowIcon size={11} className="shrink-0 text-subtle" />
          <RefPicker
            repoId={repoId}
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
        <span className="ml-1 flex shrink-0 items-baseline gap-1 text-subtle">
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
        {data?.truncated && <span className="text-subtle">diff truncated (large changeset)</span>}
        {range ? (
          <YButton variant="ghost" size="sm" onClick={() => openChanges(workspaceId)} title="The workspace's own changes">
            Review diff
          </YButton>
        ) : (
          <YButton
            variant="ghost"
            size="sm"
            onClick={() => openRange(workspaceId, { from: base ?? 'HEAD', to: WORKTREE_REF })}
            title="Compare any two branches or commits"
          >
            Compare…
          </YButton>
        )}
      </div>
    </div>
  )
}

function RefIcon({ value }: { value?: string }): JSX.Element {
  const Icon = value === WORKTREE_REF ? FileIcon : value !== undefined && (isCommit(value) || value === 'HEAD')
    ? CommitsIcon : BranchIcon
  return <Icon size={11} className="shrink-0 text-subtle" />
}

/**
 * One end of a range: origin's branches (by name, as the server tries
 * `origin/<name>` first), HEAD, the working tree when `worktree`, `PARENT`
 * when `parent`, or a commit id typed into the filter. An unset `value` is a
 * single commit's parent.
 */
function RefPicker({ repoId, value, ariaLabel, worktree = false, parent = false, onPick }: {
  repoId: string
  value?: string
  ariaLabel: string
  worktree?: boolean
  parent?: boolean
  onPick: (ref: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listed = useRepoBranches(repoId, open)
  const typed = query.trim()
  const items: YTypeaheadItem[] = [
    ...worktree ? [{ value: WORKTREE_REF, label: 'Working tree', detail: 'with uncommitted work' }] : [],
    ...parent && value !== undefined ? [{ value: PARENT, label: 'Parent', detail: 'show one commit' }] : [],
    { value: 'HEAD', label: 'HEAD', detail: 'committed only' },
    ...(listed.data?.branches ?? []).map((b) => ({ value: b, label: b })),
    ...COMMIT_PREFIX.test(typed) ? [{ value: typed, label: typed, detail: 'commit' }] : [],
  ]
  return (
    <YPopover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
      <YPopover.Trigger
        render={(
          <YChip dropdown title={ariaLabel}>
            <RefIcon value={value} />
            <span className="max-w-[160px] truncate font-mono">{value === undefined ? 'parent' : refName(value)}</span>
          </YChip>
        )}
      />
      <YPopoverPopup side="bottom" align="start" sideOffset={6} className="w-[260px]">
        <div className="px-2 pb-1 pt-1 text-sm uppercase tracking-wide text-subtle">{ariaLabel}</div>
        <YTypeahead
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
      </YPopoverPopup>
    </YPopover.Root>
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
    <div className="max-h-48 shrink-0 overflow-auto border-b border-line px-3 py-2 text-md">
      <div className="font-medium text-text">{subject}</div>
      {body && <div className="mt-1 whitespace-pre-wrap text-muted">{body}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-subtle">
        <span>{commit.author}</span>
        <span title={when.toLocaleString()}>{relativeAge(when.toISOString())}</span>
        <span className="select-all font-mono" title={commit.sha}>{commit.sha.slice(0, 7)}</span>
        {commit.parents.length > 0 && (
          <span className="flex items-center gap-1">
            {commit.parents.length > 1 ? 'parents' : 'parent'}
            {commit.parents.map((p) => (
              <YButton
                key={p}
                variant="ghost"
                size="sm"
                onClick={() => openRange(workspaceId, { to: p })}
                title={`Show ${p}`}
                className="font-mono"
              >
                {p.slice(0, 7)}
              </YButton>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
