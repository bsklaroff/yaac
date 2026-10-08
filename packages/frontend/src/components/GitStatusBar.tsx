import type { JSX } from 'react'
import { ServerError } from '@yaac/shared/errors'
import { useUiStore } from '#lib/store'
import { BranchIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { lineTotals } from '#lib/gitStatus'
import { useWorkspaceChanges } from '#lib/useWorkspaceChanges'
import { LineCountsLabel } from '#components/ui/LineCountsLabel'
import type { BranchComparison } from '@yaac/shared/types'

/**
 * Strip above a workspace's panes saying how far HEAD is ahead of and behind
 * its base branch, and how many lines differ from it in all. The base is the
 * explorer's pick, else the branch the workspace forked from. The line
 * counts open the explorer's changes view, which breaks them down.
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
  const files = data?.files ?? []
  // A failed poll leaves the last answer in `data`; show why instead of it.
  // A stopped workspace has nothing to say.
  if (isError) {
    return (
      <div className="flex h-5 shrink-0 items-start px-2 text-[11px] leading-4 text-warning md:-mt-1.5">
        {!(error instanceof ServerError && error.code === 'CONFLICT') && (
          <span className="truncate" title={error.message}>Git status unavailable: {error.message}</span>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-5 shrink-0 items-start gap-2 px-2 text-[11px] leading-4 text-text-dim md:-mt-1.5">
      {data?.branch && (
        <span className="min-w-0 truncate">
          {describe(data.branch, data.comparison)}
          {data.comparison?.fetchedAt && (
            <span className="text-text-faint"> · fetched {relativeAge(data.comparison.fetchedAt)}</span>
          )}
        </span>
      )}
      {files.length > 0 && (
        <button
          onClick={() => openChanges(workspaceId)}
          title="Review changes"
          className="shrink-0 rounded px-1 transition hover:bg-surface-2"
        >
          <LineCountsLabel counts={lineTotals(files)} />
        </button>
      )}
    </div>
  )
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`
}

/** A branch icon and the ref name. */
function refLabel(ref: string): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-text">
      <BranchIcon size={11} className="shrink-0 self-center" />
      {ref}
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
