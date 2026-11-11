import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { ServerError } from '@yaac/shared/errors'
import { useUiStore } from '#lib/store'
import { BranchIcon, CommitsIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { isCommit, refName } from '#lib/commits'
import { lineTotals } from '#lib/gitStatus'
import { useWorkspaceChanges } from '#lib/useWorkspaceChanges'
import { lastGitStatus, saveGitStatus, type GitStatusSummary } from '#lib/lastGitStatus'
import { LineCountsLabel } from '#components/ui/LineCountsLabel'
import { CheckoutSwitcher } from '#components/CheckoutSwitcher'
import { useCheckout } from '#lib/checkouts'
import type { BranchComparison, WorkspaceChanges } from '@yaac/shared/types'

/**
 * On desktop the strip tucks up under the borderless workspace bar. On mobile
 * that bar ends in a border, so the strip gets room of its own and centers
 * its text between the border and the tab strip.
 */
const BAR = 'flex h-5 shrink-0 items-start px-2 text-[11px] leading-4 md:-mt-1.5 '
  + 'max-md:h-7 max-md:items-center'

/**
 * Strip above a workspace's panes saying how far HEAD is ahead of and behind
 * its base branch, and how many lines differ from it in all. The base is the
 * Changes pane's pick, else the branch the workspace forked from. The
 * comparison opens the Commits pane, which draws it, and the line counts the
 * Changes pane, which breaks them down. A workspace with several checkouts
 * says so for the one its switcher picks, and one with no repos says that.
 *
 * Until the first answer lands it shows the last one saved for the
 * workspace (`lastGitStatus`), muted since it may be days old, so a reload
 * does not blank it for the length of a read.
 *
 * The strip always takes its height, even when empty: a row appearing later
 * would resize the panes below and send a SIGWINCH to the agent's TUI.
 */
export function GitStatusBar({ workspaceId }: { workspaceId: string }): JSX.Element {
  // Slow, since the bar is always up and each poll walks the working tree.
  // Asking for the paths keeps the explorer's tree (and the terminal's file
  // links) ready before the explorer opens; they cost no second walk.
  // Reading `dataUpdatedAt` re-renders on every poll, which keeps
  // "fetched 5m ago" current.
  const { data, error, isError, dataUpdatedAt: _polled } = useWorkspaceChanges(
    workspaceId, { listing: 'paths', poll: 10_000 },
  )
  const openChanges = useUiStore((s) => s.openChanges)
  const openCommits = useUiStore((s) => s.openCommits)
  const { known, repos } = useCheckout(workspaceId)
  const [saved] = useState(() => lastGitStatus(workspaceId))
  useEffect(() => {
    if (data) saveGitStatus(workspaceId, summarize(data))
  }, [workspaceId, data])
  const shown = data ? summarize(data) : saved
  if (known && repos.length === 0) return <div className={clsx(BAR, 'px-3 text-text-faint')}>No repos</div>
  // A failed poll leaves the last answer in `data`; show why instead of it.
  // A stopped workspace has nothing to say.
  if (isError) {
    return (
      <div className={clsx(BAR, 'text-warning')}>
        {!(error instanceof ServerError && error.code === 'CONFLICT') && (
          <span className="truncate" title={error.message}>Git status unavailable: {error.message}</span>
        )}
      </div>
    )
  }
  return (
    <div className={clsx(BAR, 'gap-2 text-text-dim', !data && 'opacity-60')}>
      <CheckoutSwitcher workspaceId={workspaceId} className="h-4" />
      {shown?.branch && (
        <button
          onClick={() => openCommits(workspaceId)}
          title="Review commits"
          className="min-w-0 truncate rounded px-1 text-left transition hover:bg-surface-2"
        >
          {describe(shown.branch, shown.comparison)}
          {shown.comparison?.fetchedAt && (
            <span className="text-text-faint"> · fetched {relativeAge(shown.comparison.fetchedAt)}</span>
          )}
        </button>
      )}
      {shown?.counts && (
        <button
          onClick={() => openChanges(workspaceId)}
          title="Review changes"
          className="shrink-0 rounded px-1 transition hover:bg-surface-2"
        >
          <LineCountsLabel counts={shown.counts} />
        </button>
      )}
    </div>
  )
}

function summarize({ branch, comparison, files }: WorkspaceChanges): GitStatusSummary {
  return { branch, comparison, counts: files.length > 0 ? lineTotals(files) : null }
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`
}

/** A branch or commit icon and the ref name. */
function refLabel(ref: string): JSX.Element {
  const Icon = isCommit(ref) ? CommitsIcon : BranchIcon
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-text">
      <Icon size={11} className="shrink-0 self-center" />
      {refName(ref)}
    </span>
  )
}

function describe(base: string, comparison: BranchComparison | null): JSX.Element {
  if (!comparison) return <>No branch named {refLabel(base)} to compare with</>
  const { ref, ahead, behind } = comparison
  const label = refLabel(ref)
  if (ahead === 0 && behind === 0) return <>Up to date with {label}</>
  if (behind === 0) return <>{commits(ahead)} ahead of {label}</>
  if (ahead === 0) return <>{commits(behind)} behind {label}</>
  return <>{commits(ahead)} ahead of, {commits(behind)} behind {label}</>
}
