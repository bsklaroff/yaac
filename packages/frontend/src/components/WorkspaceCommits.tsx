import { useMemo, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { ContextMenu } from '@base-ui/react/context-menu'
import { Popover } from '@base-ui/react/popover'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ServerError } from '@yaac/shared/errors'
import { MAX_LOG_COMMITS, WORKTREE_REF, type GitLogCommit } from '@yaac/shared/types'
import { BranchPicker } from '#components/BranchPicker'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MENU_ITEM, POPUP, PopoverPopup } from '#components/ui/menu'
import { Tip, WithTip } from '#components/ui/Tooltip'
import { api } from '#lib/api'
import { COMMITS_TARGET, layoutGraph, refName, type GraphEdge, type GraphRow } from '#lib/commits'
import {
  BranchIcon, ChevronIcon, CloseIcon, CollapseAllIcon, CommitsIcon, ExpandAllIcon, LoadingIcon, WarningIcon,
} from '#lib/icons'
import { paneViewKey, useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useProjectBranches } from '#lib/useProjectBranches'

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
 * The Commits pane: the history of HEAD and of the branch the workspace is
 * based on, as a graph beside a GitHub-style commit list. Its strip picks
 * that branch, which moves the workspace's base for the Changes pane and the
 * git status strip too. Commits only the base branch has (the ones HEAD is
 * behind by) are dimmed. Of the refs at each commit only HEAD, tags and the
 * base branch are marked, since a checkout full of agent branches would bury
 * the subjects in pills.
 *
 * A commit's message unfolds under its row, one at a time or all at once.
 * Clicking a commit shows it in a Changes pane, as `git show` does; ticking
 * two (or Cmd/Ctrl-clicking them) offers their range, older to newer. Polls
 * as often as the strip does while on screen, and is unmounted off it.
 */
export function WorkspaceCommits({ workspaceId, projectId, baseBranch, startCommit }: {
  workspaceId: string
  projectId: string
  /** The branch the workspace is based on. */
  baseBranch?: string
  /** The commit it was created at, its base when it has no branch. */
  startCommit?: string
}): JSX.Element {
  const [limit, setLimit] = useState(PAGE)
  const log = useQuery({
    queryKey: ['commits', workspaceId, limit],
    queryFn: () => api.workspace[':id'].commits.$get({ param: { id: workspaceId }, query: { limit: String(limit) } }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  })
  const data = log.data
  const { rows, width } = useMemo(() => layoutGraph(data?.commits ?? []), [data?.commits])
  const ours = useMemo(() => reachable(data?.commits ?? [], data?.head ?? null), [data?.commits, data?.head])
  const pinned = new Set([baseBranch && `origin/${baseBranch}`, data?.ref && refName(data.ref)])
  const marked = (ref: string): boolean => isHead(ref) || ref.startsWith('tag: ') || pinned.has(ref)

  const viewKey = paneViewKey(workspaceId, COMMITS_TARGET)
  const openList = useUiStore((s) => s.paneView[viewKey]?.openCommits)
  const open = useMemo(() => new Set(openList ?? []), [openList])
  const setPaneView = useUiStore((s) => s.setPaneView)
  const openRange = useUiStore((s) => s.openRange)
  const toggleOpen = (sha: string): void => {
    setPaneView(viewKey, { openCommits: open.has(sha) ? [...open].filter((o) => o !== sha) : [...open, sha] })
  }
  const bodied = (data?.commits ?? []).filter((c) => c.body !== '')
  const anyOpen = bodied.some((c) => open.has(c.sha))
  // Up to two ticked commits; a third replaces the one ticked first.
  const [picked, setPicked] = useState<string[]>([])
  const togglePick = (sha: string): void => setPicked((p) => (
    p.includes(sha) ? p.filter((x) => x !== sha) : [...p.slice(-1), sha]
  ))
  const order = new Map((data?.commits ?? []).map((c, i) => [c.sha, i]))
  // The list runs newest first, so the later one in it is the older.
  const [newer, older] = [...picked].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  const [menuCommit, setMenuCommit] = useState<GitLogCommit | null>(null)

  // A stopped workspace has no checkout to read a log from, so the strip
  // goes too; any other failure keeps it, since picking another base is
  // often the way out (one sharing no history with HEAD).
  if (log.isError && !data && log.error instanceof ServerError && log.error.code === 'CONFLICT') {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-xs text-text-dim">
        Start the workspace to see its commits.
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col bg-surface">
      <CommitsStrip
        workspaceId={workspaceId}
        projectId={projectId}
        baseBranch={baseBranch}
        startCommit={startCommit}
        error={log.isError && data ? log.error.message : undefined}
      >
        {older !== undefined && (
          <span className="flex shrink-0 items-center">
            <button
              onClick={() => openRange(workspaceId, { from: older, to: newer })}
              title="Diff the two ticked commits"
              className="rounded px-1.5 py-0.5 transition hover:bg-surface-2 hover:text-text"
            >
              Compare <span className="font-mono">{older.slice(0, 7)}</span> → <span className="font-mono">{newer.slice(0, 7)}</span>
            </button>
            <button
              onClick={() => setPicked([])}
              aria-label="Clear the ticked commits"
              className="rounded p-1 text-text-faint transition hover:bg-surface-2 hover:text-text"
            >
              <CloseIcon size={11} />
            </button>
          </span>
        )}
        {bodied.length > 0 && (
          <WithTip tip={<Tip title={anyOpen ? 'Collapse all messages' : 'Show all messages'} />}>
            <button
              onClick={() => setPaneView(viewKey, { openCommits: anyOpen ? [] : bodied.map((c) => c.sha) })}
              aria-label={anyOpen ? 'Collapse all messages' : 'Show all messages'}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text"
            >
              {anyOpen ? <CollapseAllIcon size={13} /> : <ExpandAllIcon size={13} />}
            </button>
          </WithTip>
        )}
      </CommitsStrip>
      {log.isError && !data ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-text-dim">
          <WarningIcon size={18} className="text-text-faint" />
          <span>Couldn’t load commits.</span>
          <span className="max-w-full truncate px-4 text-[11px] text-text-faint">{log.error.message}</span>
        </div>
      ) : !data ? (
        <div className="flex flex-1 items-center justify-center text-text-dim">
          <LoadingIcon size={18} className="animate-spin" />
        </div>
      ) : data.commits.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-text-dim">No commits yet.</div>
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger className="min-h-0 flex-1 overflow-auto" onContextMenuCapture={() => setMenuCommit(null)}>
            {data.commits.map((c, i) => (
              <CommitRow
                key={c.sha}
                commit={c}
                refs={c.refs.filter(marked)}
                row={rows[i]}
                width={width}
                theirs={!ours.has(c.sha)}
                open={open.has(c.sha)}
                picked={picked.includes(c.sha)}
                picking={picked.length > 0}
                onToggleOpen={() => toggleOpen(c.sha)}
                onTogglePick={() => togglePick(c.sha)}
                onShow={() => openRange(workspaceId, { to: c.sha })}
                onContextMenu={() => setMenuCommit(c)}
              />
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
          </ContextMenu.Trigger>
          {menuCommit && (
            <ContextMenu.Portal>
              <ContextMenu.Positioner>
                <ContextMenu.Popup className={clsx('min-w-[180px]', POPUP)}>
                  <ContextMenu.Item className={MENU_ITEM} onClick={() => openRange(workspaceId, { to: menuCommit.sha })}>
                    Show commit
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className={MENU_ITEM}
                    onClick={() => openRange(workspaceId, { from: menuCommit.sha, to: WORKTREE_REF })}
                  >
                    Compare with working tree
                  </ContextMenu.Item>
                  <ContextMenu.Item className={MENU_ITEM} onClick={() => openRange(workspaceId, { from: menuCommit.sha, to: 'HEAD' })}>
                    Compare with HEAD
                  </ContextMenu.Item>
                  <ContextMenu.Item className={MENU_ITEM} onClick={() => void navigator.clipboard.writeText(menuCommit.sha)}>
                    Copy commit id
                  </ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          )}
        </ContextMenu.Root>
      )}
    </div>
  )
}

/**
 * The strip under the pane's top edge: the branch the workspace is based
 * on, with a picker over origin's branches. A pick is confirmed first, since
 * it changes the workspace's base for every pane and for what is queued
 * under it.
 */
function CommitsStrip({ workspaceId, projectId, baseBranch, startCommit, error, children }: {
  workspaceId: string
  projectId: string
  baseBranch?: string
  startCommit?: string
  /** Why the latest poll failed, shown over the last answer. */
  error?: string
  /** The list's own controls, at the strip's end. */
  children?: ReactNode
}): JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const listed = useProjectBranches(projectId, open)
  const rebase = useMutation({
    mutationFn: (branch: string) => api.workspace[':id'].base.$post({ param: { id: workspaceId }, json: { branch } }),
    onSuccess: async () => {
      setPicked(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['commits', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ['changes', workspaceId] }),
      ])
    },
  })
  // The current base leads, since the list shows only its first few until
  // a filter is typed.
  const names = listed.data?.branches ?? []
  const branches = baseBranch !== undefined && names.includes(baseBranch)
    ? [baseBranch, ...names.filter((n) => n !== baseBranch)]
    : names
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-1.5 text-[11px] text-text-dim">
      <span className="shrink-0 whitespace-nowrap pl-1 text-text-faint">Based on</span>
      <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
        <Popover.Trigger
          title="Choose the branch this workspace is based on"
          className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none transition
            hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
        >
          {baseBranch === undefined && startCommit !== undefined
            ? <CommitsIcon size={11} className="shrink-0 text-text-faint" />
            : <BranchIcon size={11} className="shrink-0 text-text-faint" />}
          <span className="max-w-[220px] truncate font-mono">
            {baseBranch !== undefined ? `origin/${baseBranch}` : startCommit !== undefined ? refName(startCommit) : 'none'}
          </span>
          <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
        </Popover.Trigger>
        <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-[260px]">
          <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">Base on</div>
          <BranchPicker
            branches={branches}
            defaultBranch={listed.data?.defaultBranch}
            query={query}
            onQueryChange={setQuery}
            onSelect={(name) => {
              setOpen(false)
              setQuery('')
              if (name !== baseBranch) {
                rebase.reset()
                setPicked(name)
              }
            }}
            showList
            placeholder={listed.data ? 'filter branches…' : 'loading branches…'}
            ariaLabel="Base branch"
            className="px-1 pb-1"
          />
        </PopoverPopup>
      </Popover.Root>
      <span className="ml-auto min-w-0 truncate text-warning" title={error}>
        {error !== undefined && `Couldn’t refresh: ${error}`}
      </span>
      {children}
      <ConfirmDialog
        open={picked !== null}
        onOpenChange={(o) => { if (!o) setPicked(null) }}
        title={`Base this workspace on origin/${picked ?? ''}?`}
        description={`The Changes pane, the status bar and this pane will compare it against origin/${picked ?? ''}, `
          + 'and workspaces queued after it will fork from there. Its commits stay where they are: if they '
          + `should sit on ${picked ?? ''}, ask the agent to rebase.`}
        confirmLabel="Change base"
        destructive={false}
        busy={rebase.isPending}
        error={rebase.error?.message}
        onConfirm={() => { if (picked !== null) rebase.mutate(picked) }}
      />
    </div>
  )
}

/**
 * One commit: a line of fixed height beside its slice of the graph, and,
 * when `open`, its message's body under it, past which the graph's lanes run
 * straight on. Clicking it shows the commit; Cmd/Ctrl-click or its tick box
 * picks it for a range.
 */
function CommitRow({
  commit, refs, row, width, theirs, open, picked, picking, onToggleOpen, onTogglePick, onShow, onContextMenu,
}: {
  commit: GitLogCommit
  /** The commit's refs worth a pill. */
  refs: string[]
  row: GraphRow
  width: number
  /** Only on the base branch, not in HEAD's history. */
  theirs: boolean
  open: boolean
  picked: boolean
  /** Whether any commit is picked, which shows every tick box. */
  picking: boolean
  onToggleOpen: () => void
  onTogglePick: () => void
  onShow: () => void
  onContextMenu: () => void
}): JSX.Element {
  const when = new Date(commit.time * 1000)
  const graph = { width: width * LANE, maxWidth: '30%' }
  return (
    <div className={clsx('group', picked && 'bg-surface-2')} onContextMenu={onContextMenu}>
      <div
        onClick={(e) => (e.metaKey || e.ctrlKey ? onTogglePick() : onShow())}
        title="Show this commit"
        className={clsx('flex cursor-pointer items-center gap-2 pr-2 text-xs hover:bg-surface-2',
          theirs ? 'text-text-faint' : 'text-text')}
        style={{ height: ROW }}
      >
        <span className="flex w-5 shrink-0 justify-end">
          <input
            type="checkbox"
            checked={picked}
            onChange={onTogglePick}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Pick ${commit.sha.slice(0, 7)} to compare`}
            className={clsx('h-3 w-3 cursor-pointer accent-accent',
              picking ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100')}
          />
        </span>
        <GraphCell row={row} width={width} merge={commit.parents.length > 1} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {commit.body !== '' ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleOpen()
              }}
              aria-label={open ? 'Hide the message' : 'Show the message'}
              aria-expanded={open}
              className="-mx-0.5 shrink-0 rounded p-0.5 text-text-faint hover:text-text"
            >
              <ChevronIcon size={10} className={clsx('transition', open && 'rotate-90')} />
            </button>
          ) : <span className="w-3.5 shrink-0" />}
          {refs.map((r) => <RefPill key={r} name={r} />)}
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
      {open && (
        <div className="flex gap-2 pr-2">
          <span className="w-5 shrink-0" />
          <div className="relative shrink-0 overflow-hidden" style={graph} aria-hidden>
            {[...new Map(row.bottom.map((e) => [e.to, e.color]))].map(([lane, color]) => (
              <div key={lane} className="absolute inset-y-0" style={{ left: laneX(lane) - 0.75, width: 1.5, background: paint(color) }} />
            ))}
          </div>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pb-2 pl-5 text-[11px] text-text-dim">{commit.body}</div>
        </div>
      )}
    </div>
  )
}

/** A ref at a commit: `HEAD -> branch` as plain HEAD, since the branch a
 *  workspace's agent works on is a generated name, and tags and remote
 *  branches in their own tints. */
function RefPill({ name }: { name: string }): JSX.Element {
  const head = isHead(name)
  const label = head ? 'HEAD' : name.replace(/^tag: /, '')
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

/** Whether a decoration is HEAD: `HEAD` when detached, else `HEAD -> <branch>`.
 *  A branch named `HEAD-fix` is neither. */
function isHead(ref: string): boolean {
  return ref === 'HEAD' || ref.startsWith('HEAD -> ')
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
