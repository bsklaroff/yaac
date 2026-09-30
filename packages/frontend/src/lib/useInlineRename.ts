import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react'
import { renameWorkspace } from '#lib/createWorkspace'

/** Collapse whitespace to one line, as the server normalizes titles. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export interface InlineEdit {
  editing: boolean
  setEditing: (editing: boolean) => void
  seed: string
  inputRef: RefObject<HTMLInputElement | null>
  start: () => void
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  handleBlur: (e: FocusEvent<HTMLInputElement>) => void
}

/**
 * State for the sidebar's inline label editors (workspace titles, group
 * names). Focuses with the cursor at the end rather than selecting all,
 * commits on Enter or blur, reverts on Escape, and ignores the blur that
 * follows Enter/Escape so a rename never fires twice.
 *
 * `commit` runs only when the value differs from what was displayed, so
 * pressing Enter on an unchanged generated title doesn't make it user-set.
 */
export function useInlineEdit(displayed: string, commit: (next: string) => void): InlineEdit {
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

  const finish = (value: string): void => {
    skipBlur.current = true
    setEditing(false)
    const next = oneLine(value)
    if (next === seed) return
    commit(next)
  }

  const cancel = (): void => {
    skipBlur.current = true
    setEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Ignore the Enter that confirms an IME candidate.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value) }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }

  const handleBlur = (e: FocusEvent<HTMLInputElement>): void => {
    if (skipBlur.current) { skipBlur.current = false; return }
    finish(e.currentTarget.value)
  }

  return { editing, setEditing, seed, inputRef, start, handleKeyDown, handleBlur }
}

/** The workspace-title editor used by the header and sidebar rows. */
export function useInlineRename(workspaceId: string, displayed: string): InlineEdit {
  return useInlineEdit(displayed, (next) => {
    void renameWorkspace(workspaceId, next)
      .catch((e: unknown) => console.error('rename failed', e))
  })
}
