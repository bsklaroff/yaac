import { useEffect, useRef, useState, type JSX } from 'react'
import { RenameIcon } from '#lib/icons'
import { renameWorktree } from '#lib/createWorktree'

/** Collapse whitespace to a single line, mirroring the server's title
 *  normalization — so the seeded field and the unchanged-check below agree
 *  even when the fallback prompt is multi-line or padded. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * The worktree header's title. Normally a selectable label (so it can be copied)
 * with a pencil affordance just to its right; clicking the pencil turns the
 * label into an inline editor that renames the display title in place — Enter or
 * blur commits, Escape reverts. This replaces the old triple-dot → rename-dialog
 * flow. A blank value clears the title back to the prompt (per `renameWorktree`).
 *
 * In the Electron build the wrapper is a window-drag region so leftover header
 * space still drags the window; the interactive children opt out via `.no-drag`,
 * which is also what lets the label's text be selected for copy/paste.
 */
export function WorktreeTitle({ worktreeId, title, prompt }: {
  worktreeId: string
  /** Stored display title; empty when the worktree has none yet. */
  title: string
  /** First user prompt — shown as the label fallback when there's no title. */
  prompt: string
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  // The field's value when the editor opened — snapshotted so an unchanged
  // commit is detected exactly, even if a generated title lands mid-edit.
  const [seed, setSeed] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter/Escape unmount the input, which can fire a trailing blur; this flag
  // makes that blur a no-op so a rename never fires twice.
  const skipBlur = useRef(false)

  // What the label shows (and what the editor seeds from), sans the last-ditch
  // 'New worktree' placeholder — editing an untitled worktree starts from its
  // prompt so the user tweaks the existing text rather than an empty field.
  const displayed = title || prompt

  // Switching worktrees drops any open editor (the field is seeded on mount).
  useEffect(() => { setEditing(false) }, [worktreeId])

  useEffect(() => {
    if (editing) {
      const el = inputRef.current
      if (!el) return
      el.focus()
      // Cursor at the end, not a full select — selecting all would make the
      // first keystroke wipe the existing title instead of editing it.
      el.setSelectionRange(el.value.length, el.value.length)
    }
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

  return (
    <div className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Worktree title"
          defaultValue={seed}
          placeholder="Worktree name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) }
            else if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
          onBlur={(e) => {
            if (skipBlur.current) { skipBlur.current = false; return }
            commit(e.currentTarget.value)
          }}
          className="no-drag min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 py-0.5
            text-xs font-medium text-text outline-none"
        />
      ) : (
        <>
          <span
            className="no-drag min-w-0 select-text truncate font-medium text-text"
            onCopy={(e) => {
              // The label is a flex item (a block box), so a triple-click / line
              // select otherwise copies with stray leading/trailing newlines.
              // Write the trimmed selection to the clipboard ourselves.
              e.clipboardData.setData('text/plain', (window.getSelection()?.toString() ?? '').trim())
              e.preventDefault()
            }}
          >
            {title || prompt || 'New worktree'}
          </span>
          <button
            onClick={start}
            title="Rename worktree"
            aria-label="Rename worktree"
            className="no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint
              transition hover:bg-surface-2 hover:text-text"
          >
            <RenameIcon size={12} />
          </button>
        </>
      )}
    </div>
  )
}
