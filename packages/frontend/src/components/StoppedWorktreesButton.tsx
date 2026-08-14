import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon, DeleteIcon, RestartIcon, TOOL_LABEL } from '#lib/icons'
import { EmptyState } from '#components/ui/EmptyState'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MasterDetail } from '#components/ui/MasterDetail'
import { StoppedTranscript } from '#components/StoppedTranscript'
import { restartWorktree } from '#lib/createWorktree'
import { getStoppedWorktrees, markAllDeathsSeen, markDeathSeen } from '#lib/stoppedApi'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { useIsMobile } from '#lib/viewport'
import { isUnseenDeath, useUiStore } from '#store'
import { describeWorktreeDeathReason } from '@yaac/shared/death-reason'
import type { StoppedWorktreeEntry } from '@yaac/shared/types'

/** Human relative age from a UTC 'YYYY-MM-DD HH:MM:SS' time, '' if unset. */
function relativeAge(utc: string | undefined): string {
  if (!utc) return ''
  const t = Date.parse(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const label = (d: StoppedWorktreeEntry): string => d.title || d.prompt || 'New worktree'

/**
 * Sidebar entry point to the deleted-worktrees view plus the full-screen modal
 * it opens. Rendered as a labeled button below the Waiting/Running groups.
 * Deleted worktrees (containers gone, transcripts kept) are project-scoped, so
 * this lives in the sidebar; open state lives in the store so the overlay is a
 * sibling of the workspace, not nested in a row.
 *
 * The overlay is a search-filtered master/detail list ordered newest-deleted
 * first; picking a row shows its history metadata and a Restart action that
 * recreates the container and resumes the tool from where it left off.
 */
export function StoppedWorktreesButton({
  projectSlug,
  activeSignature,
}: {
  projectSlug: string
  /** Sorted active-worktree id list — re-fetches the deleted list whenever the
   *  active set changes (a just-deleted worktree appears, a restarted one drops). */
  activeSignature: string
}): JSX.Element {
  const open = useUiStore((s) => s.stoppedOverlayOpen)
  const openOverlay = useUiStore((s) => s.openStoppedOverlay)
  const closeOverlay = useUiStore((s) => s.closeStoppedOverlay)
  const focus = useUiStore((s) => s.stoppedOverlayFocus)
  const optimisticStopped = useUiStore((s) => s.optimisticStopped)
  const removeOptimisticStopped = useUiStore((s) => s.removeOptimisticStopped)
  const provision = useProvisionWorktree()
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()

  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string[]>([])
  const [confirm, setConfirm] = useState<StoppedWorktreeEntry | null>(null)

  // Fetch even while closed so the sidebar can hide the entry point when the
  // project has no deleted worktrees. Re-keys on the active set (activeSignature)
  // so a just-deleted worktree shows up and a restarted one drops.
  const { data } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getStoppedWorktrees(projectSlug, 100),
    staleTime: 2000,
  })

  // Once list-deleted catches up to an optimistic entry, drop the optimistic
  // copy (the fetched one takes over — same id, no flicker).
  useEffect(() => {
    if (!data) return
    const fetched = new Set(data.map((d) => d.worktreeId))
    for (const e of optimisticStopped) if (fetched.has(e.worktreeId)) removeOptimisticStopped(e.worktreeId)
  }, [data, optimisticStopped, removeOptimisticStopped])

  // A restart reuses the worktree id and clears its recorded deletion, so once
  // the restart takes effect the worktree drops out of the fetched list. Prune
  // it from `restarting` then — the filter below has done its job. Otherwise a
  // later re-delete of the same id re-enters `data` but stays hidden by that
  // filter until a browser reload resets this component-local state.
  useEffect(() => {
    if (!data) return
    const fetched = new Set(data.map((d) => d.worktreeId))
    setRestarting((r) => {
      const next = r.filter((id) => fetched.has(id))
      return next.length === r.length ? r : next
    })
  }, [data])

  // Merge optimistic just-deleted entries (this project) ahead of the fetched
  // list, de-duped, minus any mid-restart.
  const fetchedIds = new Set((data ?? []).map((d) => d.worktreeId))
  const merged = [
    ...optimisticStopped.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.worktreeId)),
    ...(data ?? []),
  ].filter((d) => !restarting.includes(d.worktreeId))

  // Unseen abnormal deaths across the whole list (search-independent) drive the
  // sidebar notification dot.
  const unseenDeaths = merged.filter(isUnseenDeath).length

  const q = queryText.trim().toLowerCase()
  const rows = q
    ? merged.filter((d) => `${label(d)} ${TOOL_LABEL[d.tool]}`.toLowerCase().includes(q))
    : merged
  // `picked` is a row the user clicked; `selected` is what the detail pane
  // shows. Desktop shows both panes, so the top row stands in there until the
  // user picks one. A phone shows the list *or* the detail, so there the detail
  // exists only once a row is actually tapped. Every consequence of opening a
  // detail keys on `picked` (see the acknowledgement effect below).
  const picked = rows.find((d) => d.worktreeId === selectedId) ?? null
  const selected = picked ?? (isMobile ? null : rows[0] ?? null)

  // Reopening the overlay on a phone should land on the list, not on whatever
  // was last read — unless it was opened from one worktree's own row, which
  // is a request to read that one.
  useEffect(() => {
    if (!open) setSelectedId(null)
    else if (focus !== null) setSelectedId(focus)
  }, [open, focus])

  // Clicking a death's row marks it seen server-side (durable, shared across
  // clients) and optimistically flips `seen` in the cached list so the dot /
  // highlight clear instantly. The `!picked.seen` guard stops the cache patch
  // from re-triggering this effect (and re-POSTing); the partial query-key
  // matcher survives activeSignature changing.
  //
  // Keyed on `picked`, never on `selected`: the desktop stand-in row is a
  // display convenience, and a durable cross-client write must not ride on it.
  // Three ways it otherwise fires for a row nobody read — merely opening the
  // overlay acknowledges the top death; each keystroke in the search box
  // re-filters `rows`, so hunting for one dead worktree walks the top match
  // through several others and acknowledges each; and `useIsMobile` is live, so
  // rotating a phone into landscape past the breakpoint materializes a
  // stand-in and acknowledges it. "Mark all as read" is the bulk path.
  useEffect(() => {
    if (!open || !picked?.deathReason || picked.seen) return
    void markDeathSeen(projectSlug, picked.worktreeId)
    queryClient.setQueriesData<StoppedWorktreeEntry[]>(
      { queryKey: ['deleted', projectSlug] },
      (old) => old?.map((e) => (e.worktreeId === picked.worktreeId ? { ...e, seen: true } : e)),
    )
  }, [open, picked, projectSlug, queryClient])

  // Dismiss every death at once. Same server-persisted acknowledgement the
  // per-row view makes, with the same optimistic cache patch so the dot and
  // row highlights clear without waiting for a refetch.
  const onMarkAllRead = (): void => {
    void markAllDeathsSeen(projectSlug)
    queryClient.setQueriesData<StoppedWorktreeEntry[]>(
      { queryKey: ['deleted', projectSlug] },
      (old) => old?.map((e) => (e.deathReason ? { ...e, seen: true } : e)),
    )
  }

  const onConfirmRestart = (entry: StoppedWorktreeEntry): void => {
    setConfirm(null)
    setRestarting((r) => [...r, entry.worktreeId])
    removeOptimisticStopped(entry.worktreeId)
    // Close the overlay so useProvisionWorktree's auto-open shows progress in
    // the main pane.
    closeOverlay()
    provision(projectSlug, entry.tool, 'restart', entry.worktreeId,
      (sid, onProgress) => restartWorktree(sid, onProgress, { projectSlug, tool: entry.tool }),
      entry.groupId)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next) openOverlay(); else closeOverlay() }}>
      {/* Entry point hidden until the project actually has deleted worktrees
          (optimistic or fetched). The overlay below stays mounted regardless so
          an open dialog keeps its exit animation if the list empties out. */}
      {merged.length > 0 && (
        <button
          onClick={() => openOverlay()}
          className="mt-1 flex w-full items-center gap-1.5 px-3 py-1 text-xs font-medium text-text-faint
            outline-none transition hover:text-text-dim
            max-md:mx-2 max-md:mt-2 max-md:w-[calc(100%-1rem)] max-md:gap-2 max-md:rounded-lg
            max-md:bg-surface-2/40 max-md:px-2.5 max-md:py-3.5 max-md:text-sm max-md:text-text-dim
            max-md:active:bg-surface-2"
        >
          <DeleteIcon size={13} className="shrink-0 max-md:hidden" />
          <DeleteIcon size={15} className="hidden shrink-0 max-md:block" />
          <span>Stopped worktrees</span>
          {/* The count reads as the same kind of row as a worktree group's
              header on desktop; on touch it is the row's second affordance,
              which is why the entry is a full tap-sized card there. */}
          <span className="text-text-faint/70">{merged.length}</span>
          {/* Decorative unread dot (aria-hidden so it stays out of the button's
              accessible name); the title is a hover tooltip. */}
          {unseenDeaths > 0 && (
            <span
              aria-hidden="true"
              title={`${unseenDeaths} worktree${unseenDeaths > 1 ? 's' : ''} died unexpectedly`}
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 max-md:h-2 max-md:w-2"
            />
          )}
        </button>
      )}

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-4 flex flex-col gap-3
          max-md:inset-0 max-md:rounded-none max-md:border-0 rounded-xl border border-hairline
          bg-surface p-4 text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95
          data-[ending-style]:opacity-0">
          <div className="flex items-center justify-between gap-2">
            <Dialog.Title className="text-xs font-semibold text-text-dim max-md:text-sm">
              Stopped worktrees
            </Dialog.Title>
            <div className="flex items-center gap-2">
              {/* Only offered when there is something unread to clear. */}
              {unseenDeaths > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  className="rounded-md px-2 py-1 text-xs font-medium text-text-faint transition
                    hover:bg-surface-2 hover:text-text max-md:px-2.5 max-md:py-2"
                >
                  Mark all as read
                </button>
              )}
              <Dialog.Close
                title="Close"
                aria-label="Close"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text max-md:h-9 max-md:w-9"
              >
                <CloseIcon size={14} />
              </Dialog.Close>
            </div>
          </div>

          {merged.length === 0 ? (
            <EmptyState
              className="flex-1"
              title="No stopped worktrees"
              description="Worktrees you stop are kept here so you can restart them."
            />
          ) : (
            <MasterDetail
              detailOpen={isMobile && picked !== null}
              onBack={() => setSelectedId(null)}
              backLabel="Back to stopped worktrees"
              master={
                <>
                  <input
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    placeholder="Search…"
                    className="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                      outline-none focus:border-border-strong max-md:py-2.5"
                  />
                  <ul className="min-h-0 flex-1 overflow-y-auto">
                    {rows.length === 0 && (
                      <li className="px-2 py-2 text-xs text-text-faint">No matches.</li>
                    )}
                    {rows.map((d) => {
                      const unseen = isUnseenDeath(d)
                      return (
                      <li key={d.worktreeId}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(d.worktreeId)}
                          className={clsx(
                            'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition max-md:py-3',
                            selected?.worktreeId === d.worktreeId
                              ? 'bg-surface-2'
                              : unseen ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'hover:bg-surface-2/50',
                          )}
                        >
                          <span className="flex items-center gap-1.5">
                            {unseen && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                            <span className="truncate text-sm font-medium text-text-dim">{label(d)}</span>
                          </span>
                          <span className="flex items-center gap-2 text-[11px] text-text-faint">
                            <span className="truncate">
                              {d.deathReason
                                ? `died ${relativeAge(d.stoppedAt)} — ${describeWorktreeDeathReason(d.deathReason)}`
                                : d.stoppedAt ? `stopped ${relativeAge(d.stoppedAt)}` : relativeAge(d.lastActiveAt ?? d.createdAt)}
                            </span>
                            <span className="ml-auto shrink-0">{TOOL_LABEL[d.tool]}</span>
                          </span>
                        </button>
                      </li>
                      )
                    })}
                  </ul>
                </>
              }
              detail={
                <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-hairline-soft bg-bg/50 p-4
                  max-md:border-0 max-md:bg-transparent max-md:p-0">
                  {selected && (
                    <>
                      {/* Title and metadata are shrink-0 so a long prompt (the
                          one flex-1 band) can't squeeze them into clipped
                          lines on a short phone screen. */}
                      <h3 className="shrink-0 text-sm font-semibold text-text max-md:text-[0.9375rem]">
                        {label(selected)}
                      </h3>
                      <dl className="mt-3 grid shrink-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-text-faint">
                        <dt>Tool</dt><dd className="text-text-dim">{TOOL_LABEL[selected.tool]}</dd>
                        <dt>Created</dt><dd className="text-text-dim">{relativeAge(selected.createdAt) || '—'}</dd>
                        <dt>Last active</dt><dd className="text-text-dim">{relativeAge(selected.lastActiveAt) || '—'}</dd>
                        <dt>{selected.deathReason ? 'Died' : 'Stopped'}</dt>
                        <dd className="text-text-dim">{relativeAge(selected.stoppedAt) || '—'}</dd>
                        {selected.deathReason && (
                          <>
                            <dt>Cause</dt>
                            <dd className="text-text-dim">
                              {describeWorktreeDeathReason(selected.deathReason, selected.deathDetail)}
                            </dd>
                          </>
                        )}
                      </dl>
                      {/* The conversation itself, where the founding ask alone
                          used to be. Keyed by worktree so switching rows
                          starts the pane over rather than carrying the last
                          one's chosen conversation into it. */}
                      <StoppedTranscript
                        key={selected.worktreeId}
                        worktreeId={selected.worktreeId}
                        sessions={selected.agentSessions}
                        tool={selected.tool}
                        prompt={selected.prompt}
                      />
                      <button
                        type="button"
                        onClick={() => setConfirm(selected)}
                        className="mt-4 flex w-fit items-center gap-1.5 self-end rounded-md bg-surface-3 px-3 py-1.5
                          text-xs font-medium text-text transition hover:bg-border-strong
                          max-md:w-full max-md:justify-center max-md:py-3 max-md:text-sm"
                      >
                        <RestartIcon size={13} />
                        Restart
                      </button>
                    </>
                  )}
                </div>
              }
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(next) => { if (!next) setConfirm(null) }}
        destructive={false}
        title="Restart this worktree?"
        description={confirm
          ? (confirm.deathReason ? `This worktree died: ${describeWorktreeDeathReason(confirm.deathReason)}. ` : '')
            + `Recreates the container and resumes ${TOOL_LABEL[confirm.tool]} from where it left off${confirm.prompt ? `:\n“${confirm.prompt}”` : '.'}`
          : ''}
        confirmLabel="Restart"
        onConfirm={() => { if (confirm) onConfirmRestart(confirm) }}
      />
    </Dialog.Root>
  )
}
