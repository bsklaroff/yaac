import type { JSX, MouseEvent } from 'react'
import { AddIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'

/**
 * Opens the new-workspace pane (`NewWorkspacePane`) with its prompt focused.
 * The button blurs itself first so no focus ring is left on it.
 */
export function NewWorkspaceButton({ projectId }: { projectId: string }): JSX.Element | null {
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const readOnly = useReadOnly()
  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    e.currentTarget.blur()
    openNewWorkspace({ projectId })
  }
  if (readOnly) return null
  return (
    <button
      type="button"
      title="New workspace"
      aria-label="New workspace"
      onClick={open}
      className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
        hover:text-accent max-md:h-9 max-md:w-9"
    >
      <AddIcon size={14} />
    </button>
  )
}
