import type { JSX } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useUiStore } from '#lib/store'
import { getWorkspaceGitStatus } from '#lib/changesApi'
import { BranchIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import type { WorkspaceGitStatus } from '@yaac/shared/types'

/**
 * The strip above a workspace's panes: how many commits HEAD is ahead of and
 * behind its reference branch, said in words — a bare branch name there reads
 * as the branch you are on. The branch follows the Changes pane's pick, so the
 * two never disagree about what "base" means; without one it is the branch the
 * workspace forked from.
 */
export function GitStatusBar({ workspaceId }: { workspaceId: string }): JSX.Element {
  const pick = useUiStore((s) => s.changesBase[workspaceId])
  // `dataUpdatedAt` is read so every poll re-renders, even one with an
  // unchanged answer: that is what moves "fetched 5m ago" along.
  const { data, dataUpdatedAt: _polled } = useQuery({
    queryKey: ['git-status', workspaceId, pick ?? null],
    queryFn: () => getWorkspaceGitStatus(workspaceId, pick),
    refetchInterval: 10_000,
    staleTime: 5_000,
    // A new pick keeps the old line until its answer lands.
    placeholderData: keepPreviousData,
  })
  // The strip is there from the first frame, empty until there is something
  // to say: a row appearing later would resize every pane under it, and each
  // resize is a SIGWINCH to the agent's TUI. On desktop it tucks up into the
  // header row's bottom padding, so it reads as the title's subtitle.
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

/** The ref as it was before this bar spoke in sentences: a branch icon and
 *  the name. */
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
