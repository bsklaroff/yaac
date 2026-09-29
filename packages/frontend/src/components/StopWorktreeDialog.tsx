import { useRef, type JSX } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { QueuedIcon } from '#lib/icons'
import { agentLabel } from '#lib/agentLabel'
import { discardQueuedWorktree } from '#lib/queueApi'
import { clip, queuedChildren, queuedTitle } from '#lib/queued'
import { useSnapshot } from '#lib/useSnapshot'
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { useUiStore } from '#lib/store'
import type { QueuedWorktreeEntry, WorktreeListEntry } from '@yaac/shared/types'

/**
 * Confirm stopping a worktree — the sidebar row menu's Stop… and Alt+D.
 *
 * With nothing queued after the worktree it is a plain confirm. With queued
 * worktrees it lists them, because stopping is what starts them: each direct
 * child can be edited (the create dialog opens over this one) or discarded
 * (immediately — this dialog is already the confirmation) before it does.
 * Entries further down a chain are shown under their parent and marked as
 * waiting: they start after THEIR parent stops, not with this stop.
 *
 * The confirm button takes initial focus, so Alt+D then Enter still stops.
 */
export function StopWorktreeDialog({
  worktree,
  onOpenChange,
  onConfirm,
}: {
  /** The worktree to stop; null keeps the dialog closed. */
  worktree: WorktreeListEntry | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const finalFocus = useOpenerFocus(worktree !== null)
  const snapshot = useSnapshot()
  const openCreateWorktree = useUiStore((s) => s.openCreateWorktree)
  // Kept through the close animation, when `worktree` is already null.
  const last = useRef(worktree)
  if (worktree !== null) last.current = worktree
  const shown = last.current

  const children = queuedChildren(snapshot?.queuedWorktrees ?? [])
  const direct = shown !== null ? children.get(shown.worktreeId) ?? [] : []
  const name = shown ? clip(shown.title || shown.prompt || 'New worktree') : ''

  const renderEntry = (entry: QueuedWorktreeEntry, depth: number): JSX.Element => (
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
          onClick={() => openCreateWorktree({ projectSlug: entry.projectSlug, editId: entry.id })}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-dim transition hover:bg-surface-3 hover:text-text"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            void discardQueuedWorktree(entry.id).catch((e: unknown) => console.error('discard failed', e))
          }}
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
    <AlertDialog.Root open={worktree !== null} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup
          initialFocus={confirmRef}
          finalFocus={finalFocus}
          className="fixed left-1/2 top-1/2 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_var(--shadow-color)]
            outline-none transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
            data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
        >
          <AlertDialog.Title className="text-sm font-semibold">{`Stop “${name}”?`}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs leading-relaxed text-text-dim">
            Stops and removes the worktree's container. The worktree history and worktree will be saved,
            and can be restarted.
          </AlertDialog.Description>
          {direct.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide text-text-faint">Starts when this stops</p>
              <ul className="mt-1 max-h-[240px] overflow-y-auto">{direct.map((e) => renderEntry(e, 0))}</ul>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text"
            >
              Cancel
            </AlertDialog.Close>
            <button
              ref={confirmRef}
              onClick={onConfirm}
              className="flex h-8 items-center rounded-md bg-[#c94a4a] px-3 text-xs font-medium text-white transition
                hover:bg-[#d65858]"
            >
              {direct.length > 0 ? `Stop and start ${direct.length} queued` : 'Stop'}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
