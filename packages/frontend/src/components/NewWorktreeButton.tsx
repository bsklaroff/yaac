import type { JSX } from 'react'
import { AddIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'

/**
 * "+ New worktree" for the active project: opens the create dialog
 * (`CreateWorktreeDialog`, mounted once in App) with the prompt focused, the
 * same as Alt+N. `cta` is the labeled variant for empty states — the same
 * dialog behind a bigger target.
 */
export function NewWorktreeButton(
  { projectSlug, variant = 'icon' }: { projectSlug: string; variant?: 'icon' | 'cta' },
): JSX.Element {
  const openCreateWorktree = useUiStore((s) => s.openCreateWorktree)
  const open = (): void => openCreateWorktree({ projectSlug, focus: 'prompt' })
  return variant === 'cta' ? (
    <button
      type="button"
      title="New worktree"
      onClick={open}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5
        text-xs font-medium text-text-dim transition hover:border-accent/50 hover:text-accent"
    >
      <AddIcon size={14} /> New worktree
    </button>
  ) : (
    <button
      type="button"
      title="New worktree"
      aria-label="New worktree"
      onClick={open}
      className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
        hover:text-accent max-md:h-9 max-md:w-9"
    >
      <AddIcon size={14} />
    </button>
  )
}
