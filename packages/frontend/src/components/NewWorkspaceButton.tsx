import type { JSX, MouseEvent } from 'react'
import { AddIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'

/**
 * Opens `CreateWorkspaceDialog` with the prompt focused. `cta` is a larger,
 * labeled variant for empty states. The button blurs itself first so the
 * dialog records no opener (`useOpenerFocus`) and closing it doesn't leave a
 * focus ring on the button.
 */
export function NewWorkspaceButton(
  { projectId, variant = 'icon' }: { projectId: string; variant?: 'icon' | 'cta' },
): JSX.Element | null {
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const readOnly = useReadOnly()
  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    e.currentTarget.blur()
    openCreateWorkspace({ projectId, focus: 'prompt' })
  }
  if (readOnly) return null
  return variant === 'cta' ? (
    <button
      type="button"
      title="New workspace"
      onClick={open}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5
        text-xs font-medium text-text-dim transition hover:border-accent/50 hover:text-accent"
    >
      <AddIcon size={14} /> New workspace
    </button>
  ) : (
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
