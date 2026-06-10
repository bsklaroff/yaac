import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MoreIcon, RenameIcon, RestartIcon } from '@/frontend/lib/icons'
import { InputDialog } from '@/frontend/components/ui/InputDialog'
import { barIconButtonClass } from '@/frontend/components/ui/WorkspaceBar'
import { renameSession, restartSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'

const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none'

/**
 * Per-session header actions: rename (display title) and restart (kill +
 * resume). Delete lives on the sidebar row's hover × (a single, optimistic
 * delete path).
 */
export function SessionActionsMenu({
  sessionId,
  currentTitle = '',
  triggerClassName,
  iconSize = 16,
}: {
  sessionId: string
  currentTitle?: string
  /** Override the trigger button's classes (e.g. the sidebar row's
   *  hover-revealed variant). */
  triggerClassName?: string
  iconSize?: number
}): JSX.Element {
  const reconnectTerminal = useUiStore((s) => s.reconnectTerminal)
  const [renaming, setRenaming] = useState(false)

  const onRestart = (): void => {
    void restartSession(sessionId, () => {})
      .then(() => reconnectTerminal(sessionId))
      .catch((e: unknown) => console.error('restart failed', e))
  }

  const onRename = (title: string): void => {
    void renameSession(sessionId, title)
      .catch((e: unknown) => console.error('rename failed', e))
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          title="Session actions"
          aria-label="Session actions"
          className={triggerClassName ?? barIconButtonClass('dim')}
        >
          <MoreIcon size={iconSize} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="min-w-[160px] rounded-lg border border-border bg-surface-2 p-1 text-text
              shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
              <Menu.Item
                className={clsx(ITEM, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')}
                onClick={() => setRenaming(true)}
              >
                <RenameIcon size={14} />
                Rename
              </Menu.Item>
              <Menu.Item
                className={clsx(ITEM, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')}
                onClick={onRestart}
              >
                <RestartIcon size={14} />
                Restart
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
