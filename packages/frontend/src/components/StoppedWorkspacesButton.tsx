import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DeleteIcon, RestartIcon } from '#lib/icons'
import { agentLabel, workspaceModel } from '#lib/agentLabel'
import { EmptyState } from '#components/ui/EmptyState'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MasterDetail } from '#components/ui/MasterDetail'
import { Modal } from '#components/ui/Modal'
import { StoppedTranscript } from '#components/StoppedTranscript'
import { restartWorkspace } from '#lib/createWorkspace'
import { api } from '#lib/api'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { patchStopped } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { useReadOnly } from '#lib/viewer'
import { isUnseenDeath, useUiStore } from '#lib/store'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'
import { relativeAge } from '#lib/time'

const label = (d: StoppedWorkspaceEntry): string => d.title || d.prompt || 'New workspace'

/**
 * Sidebar button for the project's stopped workspaces, and the full-screen
 * modal it opens. Open state lives in the store so rows elsewhere can open it.
 *
 * The modal is a searchable master/detail list, newest-stopped first. A row's
 * detail shows its metadata, its conversation, and a Restart action that
 * recreates the workspace and resumes the tool.
 */
export function StoppedWorkspacesButton({
  projectId,
  stopped,
}: {
  projectId: string
  /** The project's stopped workspaces, from `useStoppedWorkspaces`. */
  stopped: StoppedWorkspaceEntry[]
}): JSX.Element {
  const open = useUiStore((s) => s.stoppedOverlayOpen)
  const openOverlay = useUiStore((s) => s.openStoppedOverlay)
  const closeOverlay = useUiStore((s) => s.closeStoppedOverlay)
  const focus = useUiStore((s) => s.stoppedOverlayFocus)
  const removeOptimisticStopped = useUiStore((s) => s.removeOptimisticStopped)
  const provision = useProvisionWorkspace()
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const readOnly = useReadOnly()

  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<StoppedWorkspaceEntry | null>(null)

  // Unseen abnormal deaths in the whole list drive the notification dot.
  const unseenDeaths = stopped.filter(isUnseenDeath).length

  const q = queryText.trim().toLowerCase()
  const rows = q
    ? stopped.filter((d) => `${label(d)} ${agentLabel(d.tool, workspaceModel(d))}`.toLowerCase().includes(q))
    : stopped
  // `picked` is the row the user clicked; `selected` is what the detail pane
  // shows. On desktop the top row stands in until the user picks one; on a
  // phone the detail waits for a tap.
  const picked = rows.find((d) => d.workspaceId === selectedId) ?? null
  const selected = picked ?? (isMobile ? null : rows[0] ?? null)

  // Reopening on a phone lands on the list, unless opened for one workspace.
  useEffect(() => {
    if (!open) setSelectedId(null)
    else if (focus !== null) setSelectedId(focus)
  }, [open, focus])

  // Clicking a death's row marks it seen on the server (shared across
  // clients) and patches the cached list so the dot clears at once.
  //
  // Keyed on `picked`, not `selected`: the desktop stand-in row changes on
  // open, on each search keystroke and on rotation, and must not mark rows
  // seen that nobody read.
  //
  // A failed write shows in the header, and a refetch puts the dot back.
  // A teammate's list is never marked: the deaths are theirs to see.
  const markSeen = useMutation({
    mutationFn: (workspaceId: string | null) => (workspaceId === null
      ? api.workspace['mark-all-deaths-seen'].$post({ json: { projectId } })
      : api.workspace['mark-death-seen'].$post({ json: { projectId, workspaceId } })),
    onMutate: (workspaceId) => patchStopped(queryClient, projectId, (e) =>
      (e.deathReason && (workspaceId === null || e.workspaceId === workspaceId) ? { ...e, seen: true } : e)),
    onError: () => queryClient.invalidateQueries({ queryKey: ['stopped', projectId] }),
  })
  // A row is marked at most once per page load, so a failing write, whose
  // refetch brings the row back unseen, can't loop.
  const { mutate: markOneSeen } = markSeen
  const marked = useRef(new Set<string>())
  useEffect(() => {
    if (readOnly || !open || !picked?.deathReason || picked.seen || marked.current.has(picked.workspaceId)) return
    marked.current.add(picked.workspaceId)
    markOneSeen(picked.workspaceId)
  }, [readOnly, open, picked, markOneSeen])

  const onConfirmRestart = (entry: StoppedWorkspaceEntry): void => {
    setConfirm(null)
    removeOptimisticStopped(entry.workspaceId)
    // Close so the main pane can show the restart's progress.
    closeOverlay()
    provision(projectId, entry.tool, 'restart', entry.workspaceId,
      (sid, onProgress) => restartWorkspace(sid, onProgress),
      entry.groupId)
  }

  return (
    <>
      {/* The button needs stopped workspaces; the dialog stays mounted so it
          keeps its exit animation if the list empties. */}
      {stopped.length > 0 && (
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
          <span>Stopped workspaces</span>
          <span className="text-text-faint/70">{stopped.length}</span>
          {/* Unread dot: aria-hidden so it stays out of the button's name. */}
          {unseenDeaths > 0 && (
            <span
              aria-hidden="true"
              title={`${unseenDeaths} workspace${unseenDeaths > 1 ? 's' : ''} died unexpectedly`}
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 max-md:h-2 max-md:w-2"
            />
          )}
        </button>
      )}

      <Modal
        open={open}
        onOpenChange={(next) => { if (next) openOverlay(); else closeOverlay() }}
        variant="sheet"
        title="Stopped workspaces"
        actions={(
          <>
            {markSeen.error && <span className="text-xs text-danger">{markSeen.error.message}</span>}
            {unseenDeaths > 0 && !readOnly && (
              <button
                type="button"
                onClick={() => markSeen.mutate(null)}
                className="rounded-md px-2 py-1 text-xs font-medium text-text-faint transition
                  hover:bg-surface-2 hover:text-text max-md:px-2.5 max-md:py-2"
              >
                Mark all as read
              </button>
            )}
          </>
        )}
      >
        {stopped.length === 0 ? (
          <EmptyState
            className="flex-1"
            title="No stopped workspaces"
            description="Workspaces you stop are kept here so you can restart them."
          />
        ) : (
          <MasterDetail
            detailOpen={isMobile && picked !== null}
            onBack={() => setSelectedId(null)}
            backLabel="Back to stopped workspaces"
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
                    <li key={d.workspaceId}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(d.workspaceId)}
                        className={clsx(
                          'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition max-md:py-3',
                          selected?.workspaceId === d.workspaceId
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
                              ? `died ${relativeAge(d.stoppedAt)} — ${describeWorkspaceDeathReason(d.deathReason)}`
                              : d.stoppedAt ? `stopped ${relativeAge(d.stoppedAt)}` : `last active ${relativeAge(d.lastActiveAt ?? d.createdAt)}`}
                          </span>
                          <span className="ml-auto shrink-0">{agentLabel(d.tool, workspaceModel(d))}</span>
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
                    {/* shrink-0 so a long transcript cannot clip these on a short
                        phone screen. */}
                    <h3 className="shrink-0 text-sm font-semibold text-text max-md:text-[0.9375rem]">
                      {label(selected)}
                    </h3>
                    <dl className="mt-3 grid shrink-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-text-faint">
                      <dt>Tool</dt><dd className="text-text-dim">{agentLabel(selected.tool, workspaceModel(selected))}</dd>
                      <dt>Created</dt><dd className="text-text-dim">{relativeAge(selected.createdAt) || '—'}</dd>
                      <dt>Last active</dt><dd className="text-text-dim">{relativeAge(selected.lastActiveAt) || '—'}</dd>
                      <dt>{selected.deathReason ? 'Died' : 'Stopped'}</dt>
                      <dd className="text-text-dim">{relativeAge(selected.stoppedAt) || '—'}</dd>
                      {selected.deathReason && (
                        <>
                          <dt>Cause</dt>
                          <dd className="text-text-dim">
                            {describeWorkspaceDeathReason(selected.deathReason, selected.deathDetail)}
                          </dd>
                        </>
                      )}
                    </dl>
                    {/* Keyed by workspace so switching rows resets the chosen
                        conversation. */}
                    <StoppedTranscript
                      key={selected.workspaceId}
                      workspaceId={selected.workspaceId}
                      sessions={selected.agentSessions}
                      prompt={selected.prompt}
                    />
                    {!readOnly && <button
                      type="button"
                      onClick={() => setConfirm(selected)}
                      className="mt-4 flex w-fit items-center gap-1.5 self-end rounded-md bg-surface-3 px-3 py-1.5
                        text-xs font-medium text-text transition hover:bg-border-strong
                        max-md:w-full max-md:justify-center max-md:py-3 max-md:text-sm"
                    >
                      <RestartIcon size={13} />
                      Restart
                    </button>}
                  </>
                )}
              </div>
            }
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(next) => { if (!next) setConfirm(null) }}
        destructive={false}
        title="Restart this workspace?"
        description={confirm ? label(confirm) : ''}
        confirmLabel="Restart"
        onConfirm={() => { if (confirm) onConfirmRestart(confirm) }}
      />
    </>
  )
}
