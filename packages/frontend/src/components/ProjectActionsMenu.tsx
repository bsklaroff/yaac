import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { DeleteIcon } from '#lib/icons'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { removeProjectInBackground } from '#lib/projectOps'
import { useReadOnly } from '#lib/viewer'
import { useProjectName } from '#lib/projectIdentity'
import { useSnapshot } from '#lib/useSnapshot'

/** The project name as a menu trigger. The only action is Remove, which
 *  asks for confirmation and then runs in the background (#lib/projectOps).
 *  A teammate's project shows its plain name. */
export function ProjectActionsMenu({ projectId, remoteUrl }: {
  projectId: string
  /** The project's git remote, typed back to confirm removal (the name,
   *  for a remote yaac hosts). */
  remoteUrl: string
}): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const name = useProjectName()(projectId)
  const hosted = useSnapshot()?.projects.find((p) => p.id === projectId)?.hosted === true
  const readOnly = useReadOnly()
  if (readOnly) return <span className="truncate font-semibold tracking-tight">{name}</span>

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="-ml-2 flex min-w-0 items-center rounded-md px-2 py-1 font-semibold
          tracking-tight text-text outline-none transition hover:bg-surface-2 data-[popup-open]:bg-surface-2">
          <span className="truncate">{name}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={6}>
            <Menu.Popup className={clsx('min-w-[170px]', POPUP)}>
              <Menu.Item
                className={clsx(MENU_ITEM, 'text-danger data-[highlighted]:bg-[#c94a4a]/15 data-[highlighted]:text-danger')}
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
        title="Remove project?"
        description={hosted
          ? `Removes "${name}", all its workspaces, and its git repository, which yaac hosts and `
            + `which is the only copy of its code. To keep the code, first run "yaac project clone ${name}". `
            + 'This can\'t be undone.'
          : `Removes "${name}" and all its workspaces. This can't be undone.`}
        confirmText={hosted ? name : remoteUrl}
        confirmLabel="Remove"
        onConfirm={() => { setConfirm(false); removeProjectInBackground(projectId, name, remoteUrl) }}
      />
    </>
  )
}
