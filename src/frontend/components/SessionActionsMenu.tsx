import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { DeleteIcon, MoreIcon, RestartIcon } from '@/frontend/lib/icons'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { deleteSession, restartSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'

const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none'

/** Per-session actions: restart (kill + resume) and delete (with confirm). */
export function SessionActionsMenu({ sessionId }: { sessionId: string }): JSX.Element {
  const selectSession = useUiStore((s) => s.selectSession)
  const reconnectTerminal = useUiStore((s) => s.reconnectTerminal)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const onRestart = (): void => {
    setBusy(true)
    void restartSession(sessionId, () => {})
      .then(() => reconnectTerminal())
      .catch((e: unknown) => console.error('restart failed', e))
      .finally(() => setBusy(false))
  }

  const onConfirmDelete = (): void => {
    setBusy(true)
    void deleteSession(sessionId)
      .then(() => { selectSession(null); setConfirmDelete(false) })
      .catch((e: unknown) => console.error('delete failed', e))
      .finally(() => setBusy(false))
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
              shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
              <Menu.Item className={clsx(ITEM, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')} onClick={onRestart}>
                <RestartIcon size={14} />
                Restart
              </Menu.Item>
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item
                className={clsx(ITEM, 'text-[#d65858] data-[highlighted]:bg-[#c94a4a]/15')}
                onClick={() => setConfirmDelete(true)}
              >
                <DeleteIcon size={14} />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        busy={busy}
        title="Delete session?"
        description="Stops and removes the session's container and worktree. This can't be undone."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </>
  )
}
