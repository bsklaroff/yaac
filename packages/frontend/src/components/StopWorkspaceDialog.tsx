import { useRef, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { QueuedIcon } from '#lib/icons'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { clip, queuedChildren, queuedTitle } from '#lib/queued'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import type { QueuedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Confirm stopping a workspace (the row menu's Stop… and Alt+D).
 *
 * Stopping starts any workspaces queued after it, so the dialog lists them:
 * each direct child can be edited or discarded first (discarding needs no
 * further confirm). Deeper entries show under their parent as waiting, since
 * they start when that parent stops.
 *
 * The confirm button takes initial focus, so Alt+D then Enter stops
 * (ConfirmDialog).
 */
export function StopWorkspaceDialog({
  workspace,
  onOpenChange,
  onConfirm,
}: {
  /** The workspace to stop; null keeps the dialog closed. */
  workspace: WorkspaceListEntry | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element {
  const snapshot = useSnapshot()
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  // Kept through the close animation, when `workspace` is already null.
  const last = useRef(workspace)
  if (workspace !== null) last.current = workspace
  const shown = last.current

  const children = queuedChildren(snapshot?.queuedWorkspaces ?? [])
  const direct = shown !== null ? children.get(shown.workspaceId) ?? [] : []
  const name = shown ? clip(shown.title || shown.prompt || 'New workspace') : ''
  // The entry leaves the snapshot once discarded.
  const discard = useMutation({
    mutationFn: (id: string) => api.workspace.queue.discard.$post({ json: { id } }),
  })

  const renderEntry = (entry: QueuedWorkspaceEntry, depth: number): JSX.Element => (
    <li key={entry.id}>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 12 }}>
        <QueuedIcon size={11} className="shrink-0 text-text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-text">{queuedTitle(entry)}</span>
          <span className="block truncate text-[11px] text-text-faint">
            {agentLabel(entry.tool, entry)}{depth > 0 ? ' · waits for its parent' : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={() => openCreateWorkspace({ projectSlug: entry.projectSlug, editId: entry.id })}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-dim transition hover:bg-surface-3 hover:text-text"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => discard.mutate(entry.id)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-dim transition hover:bg-surface-3 hover:text-text"
        >
          Discard
        </button>
      </div>
      {(children.get(entry.id) ?? []).length > 0 && (
        <ul>{(children.get(entry.id) ?? []).map((c) => renderEntry(c, depth + 1))}</ul>
      )}
    </li>
  )

  return (
    <ConfirmDialog
      open={workspace !== null}
      onOpenChange={onOpenChange}
      title={`Stop “${name}”?`}
      description={'Stops and removes the workspace\'s container. The workspace history and workspace will be '
        + 'saved, and can be restarted.'}
      confirmLabel={direct.length > 0 ? `Stop and start ${direct.length} queued` : 'Stop'}
      onConfirm={onConfirm}
    >
      {direct.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-wide text-text-faint">Starts when this stops</p>
          <ul className="mt-1 max-h-[240px] overflow-y-auto">{direct.map((e) => renderEntry(e, 0))}</ul>
        </div>
      )}
      {discard.error && <p className="mt-2 text-xs text-danger">Discard failed: {discard.error.message}</p>}
    </ConfirmDialog>
  )
}
