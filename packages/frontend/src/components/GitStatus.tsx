import { useEffect, useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { ServerError } from '@yaac/shared/errors'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { refName } from '#lib/commits'
import { lineTotals } from '#lib/gitStatus'
import { useWorkspaceChanges } from '#lib/useWorkspaceChanges'
import { lastGitStatus, saveGitStatus, type GitStatusSummary } from '#lib/lastGitStatus'
import { LineCountsLabel } from '#components/LineCountsLabel'
import { CheckoutSwitcher } from '#components/CheckoutSwitcher'
import { useCheckout } from '#lib/checkouts'
import type { BranchComparison, WorkspaceChanges } from '@yaac/shared/types'
import { YButton } from '#ui'

const BAR = 'flex min-w-0 shrink items-center gap-1 text-sm'
/** The checkout picker: narrower on a phone, whose selects take a 16px
 *  font (index.css). */
const PICKER = 'h-6 text-sm max-md:max-w-[104px]'
/** One of its links: the comparison or the line counts. */
const LINK = 'h-6 rounded-sm px-1 leading-6 transition-colors hover:bg-hover hover:text-text'

/**
 * A workspace's git status, beside its title (on a phone, under it),
 * saying how far HEAD is ahead of and behind its base branch, and how many
 * lines differ from it in all. The
 * base is the Changes pane's pick, else the branch the workspace forked
 * from. The comparison opens the Commits pane, and the line counts the
 * Changes pane. A workspace with several checkouts says so for the one its
 * switcher picks, and one with no repos says that.
 *
 * Until the first answer lands it shows the last one saved for the
 * workspace (`lastGitStatus`), muted since it may be days old, so a reload
 * does not blank it for the length of a read. A saved answer for another
 * checkout is not shown, so switching checkouts empties it until the picked
 * one answers.
 *
 * Polled slowly, since it is always up and each poll walks the working
 * tree. Asking for the paths keeps the explorer's tree and the chat and
 * terminal file links ready before the explorer opens, at no second walk.
 */
export function GitStatusBar({ workspaceId }: { workspaceId: string }): JSX.Element {
  // Reading `dataUpdatedAt` re-renders on every poll, which keeps
  // "fetched 5m ago" current.
  const { data, error, isError, dataUpdatedAt: _polled } = useWorkspaceChanges(
    workspaceId, { listing: 'paths', poll: 10_000 },
  )
  const openChanges = useUiStore((s) => s.openChanges)
  const openCommits = useUiStore((s) => s.openCommits)
  const { known, repos, repo } = useCheckout(workspaceId)
  const saved = useMemo(() => lastGitStatus(workspaceId), [workspaceId])
  useEffect(() => {
    if (data) saveGitStatus(workspaceId, summarize(data, repo))
  }, [workspaceId, repo, data])
  const shown = data ? summarize(data, repo) : saved?.repo === repo ? saved : undefined
  if (known && repos.length === 0) return <div className={clsx(BAR, 'px-1 text-subtle')}>No repos</div>
  // A failed poll leaves the last answer in `data`; show why instead of it.
  // A stopped workspace (CONFLICT) has nothing to say.
  if (isError) {
    return (
      <div className={clsx(BAR, 'text-warning')}>
        {/* Another checkout may read fine, so the picker stays. */}
        <CheckoutSwitcher workspaceId={workspaceId} className={PICKER} />
        {!(error instanceof ServerError && error.code === 'CONFLICT') && (
          <span className="truncate px-1" title={error.message}>Git status unavailable: {error.message}</span>
        )}
      </div>
    )
  }
  return (
    <div className={clsx(BAR, 'text-muted', !data && 'opacity-60')}>
      <CheckoutSwitcher workspaceId={workspaceId} className={PICKER} />
      {shown?.branch && (
        <YButton
          variant="bare"
          onClick={() => openCommits(workspaceId)}
          title={`Review commits${shown.comparison?.fetchedAt ? ` (fetched ${relativeAge(shown.comparison.fetchedAt)})` : ''}`}
          className={clsx(LINK, 'min-w-0 truncate text-left')}
        >
          {describe(shown.branch, shown.comparison)}
        </YButton>
      )}
      {shown?.comparison?.rewritten === true && (
        <span className="shrink-0 text-warning" title={rewrittenHint(shown.comparison.ref)}>base rewritten</span>
      )}
      {shown?.counts && (
        <YButton variant="bare" onClick={() => openChanges(workspaceId)} title="Review changes" className={clsx(LINK, 'shrink-0')}>
          <LineCountsLabel counts={shown.counts} />
        </YButton>
      )}
    </div>
  )
}

function summarize({ branch, comparison, files }: WorkspaceChanges, repo: string | undefined): GitStatusSummary {
  return { branch, comparison, counts: files.length > 0 ? lineTotals(files) : null, ...repo !== undefined ? { repo } : {} }
}

/** "2 ahead of origin/main", in few words, since the bar is short of
 *  room. A plain inline run, so a narrow bar truncates it a letter at a
 *  time rather than dropping the ref name whole. */
/** What a workspace whose base branch was rewritten under it should run
 *  (docs/repo-forks.md "Catching up with the upstream"). */
function rewrittenHint(ref: string): string {
  return `${refName(ref)} was rewritten since this workspace started, so it counts the old commits as its own. `
    + `Run \`git rebase ${refName(ref)}\`; git drops the commits the new base already has.`
}

function describe(base: string, comparison: BranchComparison | null): JSX.Element {
  const ref = (r: string): JSX.Element => <span className="font-mono text-text">{refName(r)}</span>
  if (!comparison) return <>no {ref(base)} to compare with</>
  const { ahead, behind } = comparison
  if (ahead === 0 && behind === 0) return <>up to date with {ref(comparison.ref)}</>
  if (behind === 0) return <>{ahead} ahead of {ref(comparison.ref)}</>
  if (ahead === 0) return <>{behind} behind {ref(comparison.ref)}</>
  return <>{ahead} ahead, {behind} behind {ref(comparison.ref)}</>
}
