import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon, DeleteIcon, RestartIcon, TOOL_LABEL } from '#lib/icons'
import { EmptyState } from '#components/ui/EmptyState'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { restartSession } from '#lib/createSession'
import { getDeletedSessions, markDeathSeen } from '#lib/deletedApi'
import { useProvisionSession } from '#lib/useProvisionSession'
import { isUnseenDeath, useUiStore } from '#store'
import { describeSessionDeathReason } from '@yaac/shared/death-reason'
import type { DeletedSessionEntry } from '@yaac/shared/types'

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

const label = (d: DeletedSessionEntry): string => d.title || d.prompt || 'New session'

/**
 * Sidebar entry point to the deleted-sessions view plus the full-screen modal
 * it opens. Rendered as a labeled button below the Waiting/Running groups.
 * Deleted sessions (containers gone, transcripts kept) are project-scoped, so
 * this lives in the sidebar; open state lives in the store so the overlay is a
 * sibling of the workspace, not nested in a row.
 *
 * The overlay is a search-filtered master/detail list ordered newest-deleted
 * first; picking a row shows its history metadata and a Restart action that
 * recreates the container and resumes the tool from where it left off.
 */
export function DeletedSessionsButton({
  projectSlug,
  activeSignature,
}: {
  projectSlug: string
  /** Sorted active-session id list — re-fetches the deleted list whenever the
   *  active set changes (a just-deleted session appears, a restarted one drops). */
  activeSignature: string
}): JSX.Element {
  const open = useUiStore((s) => s.deletedOverlayOpen)
  const openOverlay = useUiStore((s) => s.openDeletedOverlay)
  const closeOverlay = useUiStore((s) => s.closeDeletedOverlay)
  const optimisticDeleted = useUiStore((s) => s.optimisticDeleted)
  const removeOptimisticDeleted = useUiStore((s) => s.removeOptimisticDeleted)
  const provision = useProvisionSession()
  const queryClient = useQueryClient()

  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string[]>([])
  const [confirm, setConfirm] = useState<DeletedSessionEntry | null>(null)

  // Fetch even while closed so the sidebar can hide the entry point when the
  // project has no deleted sessions. Re-keys on the active set (activeSignature)
  // so a just-deleted session shows up and a restarted one drops.
  const { data } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getDeletedSessions(projectSlug, 100),
    staleTime: 2000,
  })

  // Once list-deleted catches up to an optimistic entry, drop the optimistic
  // copy (the fetched one takes over — same id, no flicker).
  useEffect(() => {
    if (!data) return
    const fetched = new Set(data.map((d) => d.sessionId))
    for (const e of optimisticDeleted) if (fetched.has(e.sessionId)) removeOptimisticDeleted(e.sessionId)
  }, [data, optimisticDeleted, removeOptimisticDeleted])

  // A restart reuses the session id and clears its recorded deletion, so once
  // the restart takes effect the session drops out of the fetched list. Prune
  // it from `restarting` then — the filter below has done its job. Otherwise a
  // later re-delete of the same id re-enters `data` but stays hidden by that
  // filter until a browser reload resets this component-local state.
  useEffect(() => {
    if (!data) return
    const fetched = new Set(data.map((d) => d.sessionId))
    setRestarting((r) => {
      const next = r.filter((id) => fetched.has(id))
      return next.length === r.length ? r : next
    })
  }, [data])

  // Merge optimistic just-deleted entries (this project) ahead of the fetched
  // list, de-duped, minus any mid-restart.
  const fetchedIds = new Set((data ?? []).map((d) => d.sessionId))
  const merged = [
    ...optimisticDeleted.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.sessionId)),
    ...(data ?? []),
  ].filter((d) => !restarting.includes(d.sessionId))

  // Unseen abnormal deaths across the whole list (search-independent) drive the
  // sidebar notification dot.
  const unseenDeaths = merged.filter(isUnseenDeath).length

  const q = queryText.trim().toLowerCase()
  const rows = q
    ? merged.filter((d) => `${label(d)} ${TOOL_LABEL[d.tool]}`.toLowerCase().includes(q))
    : merged
  const selected = rows.find((d) => d.sessionId === selectedId) ?? rows[0] ?? null

  // Viewing a death's detail marks it seen server-side (durable, shared across
  // clients) and optimistically flips `seen` in the cached list so the dot /
  // highlight clear instantly. Runs for the auto-selected top row and for any
  // row the user clicks; only while the overlay is open. The `!selected.seen`
  // guard stops the cache patch from re-triggering this effect (and re-POSTing);
  // the partial query-key matcher survives activeSignature changing.
  useEffect(() => {
    if (!open || !selected?.deathReason || selected.seen) return
    void markDeathSeen(projectSlug, selected.sessionId)
    queryClient.setQueriesData<DeletedSessionEntry[]>(
      { queryKey: ['deleted', projectSlug] },
      (old) => old?.map((e) => (e.sessionId === selected.sessionId ? { ...e, seen: true } : e)),
    )
  }, [open, selected, projectSlug, queryClient])

  const onConfirmRestart = (entry: DeletedSessionEntry): void => {
    setConfirm(null)
    setRestarting((r) => [...r, entry.sessionId])
    removeOptimisticDeleted(entry.sessionId)
    // Close the overlay so useProvisionSession's auto-open shows progress in
    // the main pane.
    closeOverlay()
    provision(projectSlug, entry.tool, 'restart', entry.sessionId,
      (sid, onProgress) => restartSession(sid, onProgress, { projectSlug, tool: entry.tool }))
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next) openOverlay(); else closeOverlay() }}>
      {/* Entry point hidden until the project actually has deleted sessions
          (optimistic or fetched). The overlay below stays mounted regardless so
          an open dialog keeps its exit animation if the list empties out. */}
      {merged.length > 0 && (
        <button
          onClick={openOverlay}
          className="mt-1 flex w-full items-center gap-1.5 px-3 py-1 text-xs font-medium text-text-faint
            outline-none transition hover:text-text-dim"
        >
          <DeleteIcon size={13} className="shrink-0" />
          <span>Deleted sessions</span>
          {/* Decorative unread dot (aria-hidden so it stays out of the button's
              accessible name); the title is a hover tooltip. */}
          {unseenDeaths > 0 && (
            <span
              aria-hidden="true"
              title={`${unseenDeaths} session${unseenDeaths > 1 ? 's' : ''} died unexpectedly`}
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            />
          )}
        </button>
      )}

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-4 flex flex-col gap-3 rounded-xl border border-hairline
          bg-surface p-4 text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95
          data-[ending-style]:opacity-0">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-xs font-semibold text-text-dim">Deleted sessions</Dialog.Title>
            <Dialog.Close
              title="Close"
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text"
            >
              <CloseIcon size={14} />
            </Dialog.Close>
          </div>

          {merged.length === 0 ? (
            <EmptyState
              className="flex-1"
              title="No deleted sessions"
              description="Sessions you delete are kept here so you can restart them."
            />
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              {/* Master: search + list */}
              <div className="flex w-80 shrink-0 flex-col gap-2">
                <input
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder="Search…"
                  className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                    outline-none focus:border-border-strong"
                />
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {rows.length === 0 && (
                    <li className="px-2 py-2 text-xs text-text-faint">No matches.</li>
                  )}
                  {rows.map((d) => {
                    const unseen = isUnseenDeath(d)
                    return (
                    <li key={d.sessionId}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(d.sessionId)}
                        className={clsx(
                          'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition',
                          selected?.sessionId === d.sessionId
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
                              ? `died ${relativeAge(d.deletedAt)} — ${describeSessionDeathReason(d.deathReason)}`
                              : d.deletedAt ? `deleted ${relativeAge(d.deletedAt)}` : relativeAge(d.lastActiveAt ?? d.createdAt)}
                          </span>
                          <span className="ml-auto shrink-0">{TOOL_LABEL[d.tool]}</span>
                        </span>
                      </button>
                    </li>
                    )
                  })}
                </ul>
              </div>

              {/* Detail */}
              <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-hairline-soft bg-bg/50 p-4">
                {selected && (
                  <>
                    <h3 className="text-sm font-semibold text-text">{label(selected)}</h3>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-text-faint">
                      <dt>Tool</dt><dd className="text-text-dim">{TOOL_LABEL[selected.tool]}</dd>
                      <dt>Created</dt><dd className="text-text-dim">{relativeAge(selected.createdAt) || '—'}</dd>
                      <dt>Last active</dt><dd className="text-text-dim">{relativeAge(selected.lastActiveAt) || '—'}</dd>
                      <dt>{selected.deathReason ? 'Died' : 'Deleted'}</dt>
                      <dd className="text-text-dim">{relativeAge(selected.deletedAt) || '—'}</dd>
                      {selected.deathReason && (
                        <>
                          <dt>Cause</dt>
                          <dd className="text-text-dim">
                            {describeSessionDeathReason(selected.deathReason, selected.deathDetail)}
                          </dd>
                        </>
                      )}
                    </dl>
                    {selected.prompt && (
                      <p className="mt-4 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded bg-bg/80 p-2.5
                        text-xs leading-relaxed text-text-dim">
                        {selected.prompt}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirm(selected)}
                      className="mt-4 flex w-fit items-center gap-1.5 self-end rounded-md bg-surface-3 px-3 py-1.5
                        text-xs font-medium text-text transition hover:bg-border-strong"
                    >
                      <RestartIcon size={13} />
                      Restart
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(next) => { if (!next) setConfirm(null) }}
        destructive={false}
        title="Restart this session?"
        description={confirm
          ? (confirm.deathReason ? `This session died: ${describeSessionDeathReason(confirm.deathReason)}. ` : '')
            + `Recreates the container and resumes ${TOOL_LABEL[confirm.tool]} from where it left off${confirm.prompt ? `:\n“${confirm.prompt}”` : '.'}`
          : ''}
        confirmLabel="Restart"
        onConfirm={() => { if (confirm) onConfirmRestart(confirm) }}
      />
    </Dialog.Root>
  )
}
