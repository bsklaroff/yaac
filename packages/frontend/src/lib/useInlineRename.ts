import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react'
import { renameWorktree } from '#lib/createWorktree'

/** Collapse whitespace to a single line, mirroring the server's title
 *  normalization — so the seeded field and the unchanged-check below agree
 *  even when the fallback prompt is multi-line or padded. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * State machine behind every inline worktree-title editor (the header's
 * WorktreeTitle and each WorktreeList row): snapshot the current value on
 * open so an unchanged commit is detected exactly, focus the field with the
 * cursor at the end (not a full select, which would wipe the title on the
 * first keystroke), commit on Enter/blur, revert on Escape, and skip the
 * trailing blur that Enter/Escape themselves trigger when the input
 * unmounts, so a rename never fires twice.
 */
export function useInlineRename(worktreeId: string, displayed: string): {
  editing: boolean
  setEditing: (editing: boolean) => void
  seed: string
  inputRef: RefObject<HTMLInputElement | null>
  start: () => void
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  handleBlur: (e: FocusEvent<HTMLInputElement>) => void
} {
  const [editing, setEditing] = useState(false)
  const [seed, setSeed] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const skipBlur = useRef(false)

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const start = (): void => {
    skipBlur.current = false
    setSeed(oneLine(displayed))
    setEditing(true)
  }

  const commit = (value: string): void => {
    skipBlur.current = true
    setEditing(false)
    // Normalize the same way the seed (and the server) does, so an unchanged
    // edit — including internal-whitespace-only churn — is caught exactly.
    const next = oneLine(value)
    // Unchanged (e.g. edit → Enter with no edits): leave the title untouched, so
    // a model-generated title — or the prompt fallback still awaiting one — is
    // preserved rather than frozen as a user-set title.
    if (next === seed) return
    void renameWorktree(worktreeId, next)
      .catch((e: unknown) => console.error('rename failed', e))
  }

  const cancel = (): void => {
    skipBlur.current = true
    setEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }

  const handleBlur = (e: FocusEvent<HTMLInputElement>): void => {
    if (skipBlur.current) { skipBlur.current = false; return }
    commit(e.currentTarget.value)
  }

  return { editing, setEditing, seed, inputRef, start, handleKeyDown, handleBlur }
}
