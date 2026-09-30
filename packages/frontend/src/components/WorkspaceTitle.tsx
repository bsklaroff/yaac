import { useEffect, type JSX } from 'react'
import { RenameIcon } from '#lib/icons'
import { oneLine, useInlineRename } from '#lib/useInlineRename'

export { oneLine }

/**
 * The workspace header's title: a selectable label with a pencil button that
 * turns it into an inline editor (Enter or blur commits, Escape reverts). A
 * blank value clears the title.
 *
 * In Electron the wrapper is a window-drag region; the interactive children
 * opt out with `.no-drag`, which also keeps the label's text selectable.
 */
export function WorkspaceTitle({ workspaceId, title, prompt }: {
  workspaceId: string
  /** Stored display title; empty when the workspace has none yet. */
  title: string
  /** First user prompt, shown when there's no title. */
  prompt: string
}): JSX.Element {
  // Editing an untitled workspace starts from its prompt, not the
  // 'New workspace' placeholder.
  const displayed = title || prompt
  const { editing, setEditing, seed, inputRef, start, handleKeyDown, handleBlur } =
    useInlineRename(workspaceId, displayed)

  // Switching workspaces closes any open editor.
  useEffect(() => { setEditing(false) }, [workspaceId, setEditing])

  return (
    <div className="titlebar-drag flex min-w-0 flex-1 items-center gap-0.5">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Workspace title"
          defaultValue={seed}
          placeholder="Workspace name"
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className="no-drag min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 py-0.5
            text-xs font-medium text-text outline-none"
        />
      ) : (
        <>
          <span
            className="no-drag min-w-0 select-text truncate font-medium text-text"
            onCopy={(e) => {
              // As a flex item, a triple-click would copy stray newlines.
              e.clipboardData.setData('text/plain', (window.getSelection()?.toString() ?? '').trim())
              e.preventDefault()
            }}
          >
            {title || prompt || 'New workspace'}
          </span>
          <button
            onClick={start}
            title="Rename workspace"
            aria-label="Rename workspace"
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
