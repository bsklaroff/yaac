import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MoreIcon, RenameIcon } from '#lib/icons'
import { InputDialog } from '#components/ui/InputDialog'
import { renameSession } from '#lib/createSession'

const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none'

/**
 * Per-session header actions: rename (display title). Restarting a live session
 * is intentionally not offered here — restart lives only on the Deleted group's
 * optimistic, multi-at-a-time provisioning flow. Delete lives on the sidebar
 * row's hover × (a single, optimistic delete path).
 */
export function SessionActionsMenu({
  sessionId,
  currentTitle = '',
}: {
  sessionId: string
  currentTitle?: string
}): JSX.Element {
  const [renaming, setRenaming] = useState(false)

  const onRename = (title: string): void => {
    void renameSession(sessionId, title)
      .catch((e: unknown) => console.error('rename failed', e))
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="flex h-6 w-6 items-center justify-center rounded text-text-dim transition
          hover:bg-surface-2 hover:text-text">
          <MoreIcon size={16} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="min-w-[160px] rounded-lg border border-border bg-surface-2 p-1 text-text
              shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
              <Menu.Item
                className={clsx(ITEM, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')}
                onClick={() => setRenaming(true)}
              >
                <RenameIcon size={14} />
                Rename
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <InputDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename session"
        placeholder="Session name"
        initialValue={currentTitle}
        confirmLabel="Rename"
        onSubmit={onRename}
      />
    </>
  )
}
