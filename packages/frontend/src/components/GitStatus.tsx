import { useEffect, useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { ServerError } from '@yaac/shared/errors'
import { useUiStore } from '#lib/store'
import { BranchIcon, ChangesIcon, CommitsIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { isCommit, refName } from '#lib/commits'
import { lineTotals } from '#lib/gitStatus'
import { useWorkspaceChanges } from '#lib/useWorkspaceChanges'
import { lastGitStatus, saveGitStatus, type GitStatusSummary } from '#lib/lastGitStatus'
import { LineCountsLabel } from '#components/LineCountsLabel'
import { CheckoutSwitcher } from '#components/CheckoutSwitcher'
import { useCheckout } from '#lib/checkouts'
import type { BranchComparison, WorkspaceChanges } from '@yaac/shared/types'
import { YButton, YDetailRow } from '#ui'

/**
 * How far a workspace's HEAD is ahead of and behind its base branch, and how
 * many lines differ from it in all. The base is the Changes pane's pick,
 * else the branch the workspace forked from. A workspace with several
 * checkouts says so for the one its switcher picks.
 *
 * Until the first answer lands it shows the last one saved for the
 * workspace (`lastGitStatus`), muted since it may be days old, so a reload
 * does not blank it for the length of a read. A saved answer for another
 * checkout is not shown, so switching checkouts empties it until the
 * picked one answers. Polled slowly, since the workspace view reads it on
 * every width (for the top bar and the Details dot) and each poll walks the
 * working tree; asking for the paths keeps the explorer's tree and the chat
 * and terminal file links ready before the explorer opens, at no second
 * walk.
 */
export function useGitStatus(workspaceId: string): {
  shown: GitStatusSummary | undefined
  fresh: boolean
  noRepos: boolean
  error: Error | null
} {
  // Reading `dataUpdatedAt` re-renders on every poll, which keeps
  // "fetched 5m ago" current.
  const { data, error, isError, dataUpdatedAt: _polled } = useWorkspaceChanges(
    workspaceId, { listing: 'paths', poll: 10_000 },
  )
  const { known, repos, repo } = useCheckout(workspaceId)
  const saved = useMemo(() => lastGitStatus(workspaceId), [workspaceId])
  useEffect(() => {
    if (data) saveGitStatus(workspaceId, summarize(data, repo))
  }, [workspaceId, repo, data])
  // A failed poll leaves the last answer in `data`; show why instead of it.
  // A stopped workspace (CONFLICT) has nothing to say.
  const failure = isError && !(error instanceof ServerError && error.code === 'CONFLICT') ? error : null
  return {
    shown: isError ? undefined : data ? summarize(data, repo) : saved?.repo === repo ? saved : undefined,
    fresh: data !== undefined,
    noRepos: known && repos.length === 0,
    error: failure,
  }
}

/** The top bar's git summary: how HEAD compares with its base (opening the
 *  Commits pane), and the changed line counts (opening the Changes pane). */
export function GitTopBarSummary({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const { shown, fresh } = useGitStatus(workspaceId)
  const openChanges = useUiStore((s) => s.openChanges)
  const openCommits = useUiStore((s) => s.openCommits)
  if (!shown) return null
  return (
    <span className={clsx('flex min-w-0 items-center gap-1', !fresh && 'opacity-60')}>
      {shown.branch && shown.comparison && (
        <YButton variant="ghost" size="sm" onClick={() => openCommits(workspaceId)} title="Review commits"
          className="min-w-0 shrink font-normal text-subtle">
          <span className="truncate">{compact(shown.comparison)}</span>
        </YButton>
      )}
      {shown.counts && (
        <YButton variant="ghost" size="sm" onClick={() => openChanges(workspaceId)} title="Review changes">
          <LineCountsLabel counts={shown.counts} />
        </YButton>
      )}
    </span>
  )
}

/** The Details pane's Git card body: the checkout picker, how HEAD compares
 *  with its base and when that was fetched, and the changed lines. */
export function GitStatusRows({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { shown, fresh, noRepos, error } = useGitStatus(workspaceId)
  const openChanges = useUiStore((s) => s.openChanges)
  const openCommits = useUiStore((s) => s.openCommits)
  if (noRepos) return <YDetailRow>No repos</YDetailRow>
  if (error) return <YDetailRow tone="warning" title={error.message}>Git status unavailable: {error.message}</YDetailRow>
  return (
    <div className={clsx('flex flex-col gap-1', !fresh && 'opacity-60')}>
      <CheckoutSwitcher workspaceId={workspaceId} />
      {shown?.branch && (
        <YDetailRow
          icon={<BranchIcon size={13} />}
          note={shown.comparison?.fetchedAt ? `fetched ${relativeAge(shown.comparison.fetchedAt)}` : undefined}
          action={<YButton variant="ghost" size="xs" onClick={() => openCommits(workspaceId)}>Commits</YButton>}
        >
          {describe(shown.branch, shown.comparison)}
        </YDetailRow>
      )}
      {shown && (
        <YDetailRow
          icon={<ChangesIcon size={13} />}
          action={<YButton variant="ghost" size="xs" onClick={() => openChanges(workspaceId)}>Changes</YButton>}
        >
          {shown.counts ? <LineCountsLabel counts={shown.counts} /> : 'No uncommitted changes'}
        </YDetailRow>
      )}
    </div>
  )
}

/** "2 ahead of origin/main", in as few words as fit the top bar. */
function compact({ ref, ahead, behind }: BranchComparison): string {
  const name = refName(ref)
  if (ahead === 0 && behind === 0) return `even with ${name}`
  if (behind === 0) return `${ahead} ahead of ${name}`
  if (ahead === 0) return `${behind} behind ${name}`
  return `${ahead} ahead, ${behind} behind ${name}`
}

function summarize({ branch, comparison, files }: WorkspaceChanges, repo: string | undefined): GitStatusSummary {
  return { branch, comparison, counts: files.length > 0 ? lineTotals(files) : null, ...repo !== undefined ? { repo } : {} }
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
