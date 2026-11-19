import type { JSX, MouseEvent } from 'react'
import { AddIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import { YButton } from '#ui'

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
    <YButton
      variant="ghost"
      size="sm"
      icon={AddIcon}
      title="New workspace"
      aria-label="New workspace"
      onClick={open}
      className="max-md:h-9 max-md:w-9"
    />
  )
}
