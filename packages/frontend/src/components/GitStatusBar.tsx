import type { JSX } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useUiStore } from '#lib/store'
import { getWorkspaceGitStatus } from '#lib/changesApi'
import { BranchIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import type { WorkspaceGitStatus } from '@yaac/shared/types'

/**
 * Strip above a workspace's panes saying how far HEAD is ahead of and behind
 * its base branch. The base is the Changes pane's pick, else the branch the
 * workspace forked from.
 *
 * The strip always takes its height, even when empty: a row appearing later
 * would resize the panes below and send a SIGWINCH to the agent's TUI.
 */
export function GitStatusBar({ workspaceId }: { workspaceId: string }): JSX.Element {
  const pick = useUiStore((s) => s.changesBase[workspaceId])
  // Reading `dataUpdatedAt` re-renders on every poll, which keeps
  // "fetched 5m ago" current.
  const { data, dataUpdatedAt: _polled } = useQuery({
    queryKey: ['git-status', workspaceId, pick ?? null],
    queryFn: () => getWorkspaceGitStatus(workspaceId, pick),
    refetchInterval: 10_000,
    staleTime: 5_000,
    // A new pick keeps the old line until its answer lands.
    placeholderData: keepPreviousData,
  })
  return (
    <div className="flex h-5 shrink-0 items-start px-2 text-[11px] leading-4 text-text-dim md:-mt-1.5">
      {data?.base && (
        <span className="truncate">
          {describe(data.base, data.comparison)}
          {data.comparison?.fetchedAt && (
            <span className="text-text-faint"> · fetched {relativeAge(data.comparison.fetchedAt)}</span>
          )}
        </span>
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

function describe(base: string, comparison: WorkspaceGitStatus['comparison']): JSX.Element {
  if (!comparison) return <>No branch named {refLabel(base)} to compare with</>
  const { ref, ahead, behind } = comparison
  const label = refLabel(ref)
  if (ahead === 0 && behind === 0) return <>Up to date with {label}</>
  if (behind === 0) return <>{commits(ahead)} ahead of {label}</>
  if (ahead === 0) return <>{commits(behind)} behind {label}</>
  return <>{commits(ahead)} ahead of, {commits(behind)} behind {label}</>
}
