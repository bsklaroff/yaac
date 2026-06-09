import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { DeleteIcon, MoreIcon } from '@/frontend/lib/icons'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { removeProject } from '@/frontend/lib/projectApi'
import { useUiStore } from '@/frontend/store'

const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none'

/** Actions for the active project — currently: remove (with confirm). */
export function ProjectActionsMenu({ slug }: { slug: string }): JSX.Element {
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const onConfirm = (): void => {
    setBusy(true)
    void removeProject(slug)
      .then(() => { setActiveProject(null); setConfirm(false) })
      .catch((e: unknown) => console.error('remove project failed', e))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
          hover:bg-surface-2 hover:text-text">
          <MoreIcon size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={6}>
            <Menu.Popup className="min-w-[170px] rounded-lg border border-border bg-surface-2 p-1 text-text
              shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
              <Menu.Item
                className={clsx(ITEM, 'text-[#d65858] data-[highlighted]:bg-[#c94a4a]/15')}
                onClick={() => setConfirm(true)}
              >
                <DeleteIcon size={14} />
                Remove project
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        busy={busy}
        title="Remove project?"
        description={`Removes "${slug}" and all its sessions and worktrees. This can't be undone.`}
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />
    </>
  )
}
