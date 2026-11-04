import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ServerError } from '@yaac/shared/errors'
import { MAX_LOG_COMMITS, type GitLogCommit, type WorkspaceGitLog } from '@yaac/shared/types'
import { BranchPicker } from '#components/BranchPicker'
import { PopoverPopup } from '#components/ui/menu'
import { api } from '#lib/api'
import { branchName, layoutGraph, type GraphEdge, type GraphRow } from '#lib/commits'
import { BranchIcon, ChevronIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'

/** Commits fetched at first, and added by each "load older". */
const PAGE = 200
/** Row height and lane width of the graph, in px. */
const ROW = 28
const LANE = 14
/** Lane colors, by the graph's color index. Theme tokens, so both themes
 *  keep them readable. */
const PALETTE = ['link', 'accent', 'success', 'purple', 'warning', 'danger'].map((c) => `var(--color-${c})`)
const laneX = (lane: number): number => lane * LANE + LANE / 2
const paint = (color: number): string => PALETTE[color % PALETTE.length]

/**
 * The Commits pane: the history of HEAD and of the branch it is compared
 * against, as a graph beside a GitHub-style commit list. The branch is the
 * one the Changes pane and the git status strip compare against, so picking
 * one here picks it there too. Commits only the compared branch has (the
 * ones HEAD is behind by) are dimmed. Polls as often as the strip does
 * while on screen, and is unmounted off it.
 */
export function WorkspaceCommits({ workspaceId, baseBranch }: {
  workspaceId: string
  /** The branch the workspace forked from: the compared branch by default. */
  baseBranch?: string
}): JSX.Element {
  const base = useUiStore((s) => s.changesBase[workspaceId])
  const setChangesBase = useUiStore((s) => s.setChangesBase)
  const [limit, setLimit] = useState(PAGE)
  const log = useQuery({
    queryKey: ['commits', workspaceId, base ?? null, limit],
    queryFn: () => api.workspace[':id'].commits.$get({
      param: { id: workspaceId },
      query: { ...(base ? { base } : {}), limit: String(limit) },
    }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  })
  const data = log.data
  const { rows, width } = useMemo(() => layoutGraph(data?.commits ?? []), [data?.commits])
  const ours = useMemo(() => reachable(data?.commits ?? [], data?.head ?? null), [data?.commits, data?.head])

  if (log.isError && !data) {
    const stopped = log.error instanceof ServerError && log.error.code === 'CONFLICT'
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        {stopped ? <span>Start the workspace to see its commits.</span> : (
          <>
            <WarningIcon size={18} className="text-text-faint" />
            <span>Couldn’t load commits.</span>
            <span className="max-w-full truncate px-4 text-[11px] text-text-faint">{log.error.message}</span>
            {base !== undefined && (
              <button
                onClick={() => setChangesBase(workspaceId, undefined)}
                className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
              >
                Compare with {baseBranch ?? 'the fork branch'}
              </button>
            )}
          </>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col bg-surface">
      <CommitsStrip
        workspaceId={workspaceId}
        baseBranch={baseBranch}
        data={data}
        error={log.isError ? log.error.message : undefined}
      />
      {!data ? (
        <div className="flex flex-1 items-center justify-center text-text-dim">
          <LoadingIcon size={18} className="animate-spin" />
        </div>
      ) : data.commits.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-text-dim">No commits yet.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {data.commits.map((c, i) => (
            <CommitRow key={c.sha} commit={c} row={rows[i]} width={width} theirs={!ours.has(c.sha)} />
          ))}
          {data.more && (limit < MAX_LOG_COMMITS ? (
            <button
              onClick={() => setLimit((n) => Math.min(n + PAGE, MAX_LOG_COMMITS))}
              disabled={log.isFetching}
              className="m-2 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text
                disabled:opacity-50"
            >
              Load older commits
            </button>
          ) : (
            <div className="p-2 text-[11px] text-text-faint">
              Showing the newest {MAX_LOG_COMMITS.toLocaleString()} commits.
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The strip under the pane's top edge: which branch HEAD is compared
 *  against, with a picker over the checkout's branches. */
function CommitsStrip({ workspaceId, baseBranch, data, error }: {
  workspaceId: string
  baseBranch?: string
  data: WorkspaceGitLog | undefined
  /** Why the latest poll failed, shown over the last answer. */
  error?: string
}): JSX.Element {
  const base = useUiStore((s) => s.changesBase[workspaceId])
  const setChangesBase = useUiStore((s) => s.setChangesBase)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Hundreds of branches would ride on every poll, so they are read only
  // while the picker is open.
  const listed = useQuery({
    queryKey: ['commit-branches', workspaceId],
    queryFn: async () => (await api.workspace[':id'].commits.$get({
      param: { id: workspaceId }, query: { limit: '1', branches: '1' },
    })).branches ?? [],
    enabled: open,
  })
  const label = branchName(data?.ref ?? base ?? baseBranch ?? 'HEAD only')
  // Origin's copy of the fork branch leads, since the list shows only its
  // first few until a filter is typed.
  const fork = baseBranch && `origin/${baseBranch}`
  const names = (listed.data ?? []).map(branchName)
  const branches = names.includes(fork ?? '') ? [fork!, ...names.filter((n) => n !== fork)] : names
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-1.5 text-[11px] text-text-dim">
      <span className="pl-1 text-text-faint">HEAD vs</span>
      <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
        <Popover.Trigger
          title="Choose the branch HEAD is compared against"
          className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none transition
            hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
        >
          <BranchIcon size={11} className="shrink-0 text-text-faint" />
          <span className="max-w-[220px] truncate font-mono">{label}</span>
          <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
        </Popover.Trigger>
        <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-[260px]">
          <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">Compare with</div>
          <BranchPicker
            branches={branches}
            defaultBranch={fork}
            query={query}
            onQueryChange={setQuery}
            onSelect={(name) => {
              // Local branches go by their full name, so an origin branch
              // of the same name cannot shadow them.
              setChangesBase(workspaceId, listed.data?.find((b) => branchName(b) === name) ?? name)
              setOpen(false)
              setQuery('')
            }}
            showList
            placeholder={listed.data ? 'filter branches…' : 'loading branches…'}
            ariaLabel="Compare branch"
            className="px-1 pb-1"
          />
        </PopoverPopup>
      </Popover.Root>
      {error !== undefined && (
        <span className="ml-auto min-w-0 truncate text-warning" title={error}>Couldn’t refresh: {error}</span>
      )}
    </div>
  )
}

function CommitRow({ commit, row, width, theirs }: {
  commit: GitLogCommit
  row: GraphRow
  width: number
  /** Only on the compared branch, not in HEAD's history. */
  theirs: boolean
}): JSX.Element {
  const when = new Date(commit.time * 1000)
  return (
    <div
      className={clsx('flex items-center gap-2 pr-2 text-xs hover:bg-surface-2', theirs ? 'text-text-faint' : 'text-text')}
      style={{ height: ROW }}
    >
      <GraphCell row={row} width={width} merge={commit.parents.length > 1} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {commit.refs.map((r) => <RefPill key={r} name={r} />)}
        <span className="min-w-16 truncate" title={commit.subject}>{commit.subject}</span>
      </span>
      <span className="shrink-0 truncate text-text-dim max-md:hidden" style={{ maxWidth: 140 }}>{commit.author}</span>
      <span className="w-16 shrink-0 whitespace-nowrap text-right text-text-faint" title={when.toLocaleString()}>
        {relativeAge(when.toISOString())}
      </span>
      <span className="shrink-0 select-all font-mono text-[11px] text-text-dim" title={commit.sha}>
        {commit.sha.slice(0, 7)}
      </span>
    </div>
  )
}

/** A ref at a commit: `HEAD -> branch` as the branch, marked, and tags and
 *  remote branches in their own tints. */
function RefPill({ name }: { name: string }): JSX.Element {
  const head = name.startsWith('HEAD')
  const label = name.replace(/^HEAD -> /, '').replace(/^tag: /, '')
  const tone = head
    ? 'border-accent/60 text-accent'
    : name.startsWith('tag: ') ? 'border-warning/50 text-warning' : 'border-link/40 text-link'
  return (
    <span className={clsx('min-w-0 max-w-[160px] truncate rounded border px-1 font-mono text-[10px] leading-4', tone)} title={name}>
      {label}
    </span>
  )
}

/**
 * A row's slice of the graph, `width` lanes wide. It takes at most 30% of
 * the row and clips lanes past that, so a history with many branches open
 * at once still leaves room for the subject on a phone.
 */
function GraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }): JSX.Element {
  const mid = ROW / 2
  const line = (e: GraphEdge, y0: number, y1: number): JSX.Element => {
    const x0 = laneX(e.from)
    const x1 = laneX(e.to)
    const d = x0 === x1
      ? `M${x0} ${y0}V${y1}`
      : `M${x0} ${y0}C${x0} ${(y0 + y1) / 2} ${x1} ${(y0 + y1) / 2} ${x1} ${y1}`
    return <path key={`${y0}-${e.from}-${e.to}`} d={d} stroke={paint(e.color)} strokeWidth={1.5} fill="none" />
  }
  const x = laneX(row.lane)
  return (
    <div className="shrink-0 overflow-hidden" style={{ width: width * LANE, maxWidth: '30%' }}>
      <svg width={width * LANE} height={ROW} className="block" aria-hidden>
        {row.top.map((e) => line(e, 0, mid))}
        {row.bottom.map((e) => line(e, mid, ROW))}
        <circle
          cx={x}
          cy={mid}
          r={merge ? 3 : 4}
          fill={merge ? 'var(--color-surface)' : paint(row.color)}
          stroke={paint(row.color)}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  )
}

/** The commits HEAD's history holds, walking parents from `head`. */
function reachable(commits: GitLogCommit[], head: string | null): Set<string> {
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const seen = new Set<string>()
  const todo = head === null ? [] : [head]
  for (let sha = todo.pop(); sha !== undefined; sha = todo.pop()) {
    if (seen.has(sha)) continue
    seen.add(sha)
    todo.push(...(bySha.get(sha)?.parents ?? []))
  }
  return seen
}
