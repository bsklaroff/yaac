import { memo, useRef, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { QueuedIcon } from '#lib/icons'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { clip, queuedChildren, queuedTitle } from '#lib/queued'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import type { QueuedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'
import { YButton, YConfirm } from '#ui'

/**
 * Confirm stopping a workspace (the row menu's Stop… and Alt+D).
 *
 * Stopping starts any workspaces queued after it, so the dialog lists them:
 * each direct child can be edited or discarded first (discarding needs no
 * further confirm). Deeper entries show under their parent as waiting, since
 * they start when that parent stops.
 *
 * The confirm button takes initial focus, so Alt+D then Enter stops
 * (YConfirm). Confirming closes the dialog and hands `onConfirm` the
 * workspace, so a sidebar row can pass a callback that never changes and
 * its closed dialog skips the row's renders.
 */
export const StopWorkspaceDialog = memo(function StopWorkspaceDialog({
  workspace,
  onOpenChange,
  onConfirm,
}: {
  /** The workspace to stop; null keeps the dialog closed. */
  workspace: WorkspaceListEntry | null
  onOpenChange: (open: boolean) => void
  onConfirm: (workspace: WorkspaceListEntry) => void
}): JSX.Element {
  const queued = useSnapshotSelect((s) => s?.queuedWorkspaces)
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  // Kept through the close animation, when `workspace` is already null.
  const last = useRef(workspace)
  if (workspace !== null) last.current = workspace
  const shown = last.current

  const children = queuedChildren(queued ?? [])
  const direct = shown !== null ? children.get(shown.workspaceId) ?? [] : []
  const name = shown ? clip(shown.title || shown.prompt || 'New workspace') : ''
  // The entry leaves the snapshot once discarded.
  const discard = useMutation({
    mutationFn: (id: string) => api.workspace.queue.discard.$post({ json: { id } }),
  })

  const renderEntry = (entry: QueuedWorkspaceEntry, depth: number): JSX.Element => (
    <li key={entry.id}>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 12 }}>
        <QueuedIcon size={11} className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-md text-text">{queuedTitle(entry)}</span>
          <span className="block truncate text-sm text-subtle">
            {agentLabel(entry.tool, entry)}{depth > 0 ? ' · waits for its parent' : ''}
          </span>
        </span>
        <YButton
          variant="ghost"
          size="sm"
          onClick={() => {
            onOpenChange(false)
            openNewWorkspace({ projectId: entry.projectId, editId: entry.id })
          }}
        >
          Edit
        </YButton>
        <YButton variant="ghost" size="sm" onClick={() => discard.mutate(entry.id)}>
          Discard
        </YButton>
      </div>
      {(children.get(entry.id) ?? []).length > 0 && (
        <ul>{(children.get(entry.id) ?? []).map((c) => renderEntry(c, depth + 1))}</ul>
      )}
    </li>
  )

  return (
    <YConfirm
      open={workspace !== null}
      onOpenChange={onOpenChange}
      title={`Stop “${name}”?`}
      description={'Stops and removes the workspace\'s container. Its history and changes are kept, so it can '
        + 'be restarted, but files its .gitignore matches (such as .env files and local databases) are '
        + 'deleted, except the paths kept under Settings → Project → Storage.'}
      confirmLabel={direct.length > 0 ? `Stop and start ${direct.length} queued` : 'Stop'}
      onConfirm={() => {
        if (shown) onConfirm(shown)
        onOpenChange(false)
      }}
    >
      {direct.length > 0 && (
        <div className="mt-3">
          <p className="text-sm uppercase tracking-wide text-subtle">Starts when this stops</p>
          <ul className="mt-1 max-h-[240px] overflow-y-auto">{direct.map((e) => renderEntry(e, 0))}</ul>
        </div>
      )}
      {discard.error && <p className="mt-2 text-md text-danger">Discard failed: {discard.error.message}</p>}
    </YConfirm>
  )
})
