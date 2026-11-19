import { useEffect, type JSX, type ReactNode } from 'react'
import { RenameIcon } from '#lib/icons'
import { oneLine, useInlineRename } from '#lib/useInlineRename'
import { YButton, YInput } from '#ui'

export { oneLine }

/**
 * The workspace header's title: a selectable label with a pencil button that
 * turns it into an inline editor (Enter or blur commits, Escape reverts). A
 * blank value clears the title. It keeps a minimum width, so the step chips
 * beside it on a phone's bar shrink and scroll before it disappears.
 *
 * In Electron the wrapper is a window-drag region; the interactive children
 * opt out with `.no-drag`, which also keeps the label's text selectable.
 */
export function WorkspaceTitle({ workspaceId, title, prompt, after }: {
  workspaceId: string
  /** Stored display title; empty when the workspace has none yet. */
  title: string
  /** First user prompt, shown when there's no title. */
  prompt: string
  /** Shown after the pencil, such as the routine a run came from. */
  after?: ReactNode
}): JSX.Element {
  // Editing an untitled workspace starts from its prompt, not the
  // 'New workspace' placeholder.
  const displayed = title || prompt
  const { editing, setEditing, seed, inputRef, start, handleKeyDown, handleBlur } =
    useInlineRename(workspaceId, displayed)

  // Switching workspaces closes any open editor.
  useEffect(() => { setEditing(false) }, [workspaceId, setEditing])

  return (
    <div className="titlebar-drag flex min-w-24 flex-1 items-center gap-0.5">
      {editing ? (
        <YInput
          ref={inputRef}
          aria-label="Workspace title"
          defaultValue={seed}
          placeholder="Workspace name"
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className="no-drag flex-1 font-medium"
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
          <YButton
            variant="ghost"
            size="sm"
            icon={RenameIcon}
            onClick={start}
            title="Rename workspace"
            aria-label="Rename workspace"
            className="no-drag"
          />
          {after}
        </>
      )}
    </div>
  )
}
