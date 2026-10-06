import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { DeleteIcon } from '#lib/icons'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import { useProjectName } from '#lib/projectIdentity'

/** The project name as a menu trigger. The only action is Remove, which
 *  asks for confirmation. */
export function ProjectActionsMenu({ projectId, remoteUrl }: {
  projectId: string
  /** The project's git remote, typed back to confirm removal. */
  remoteUrl: string
}): JSX.Element {
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const [confirm, setConfirm] = useState(false)
  const name = useProjectName()(projectId)
  const remove = useMutation({
    mutationFn: () => api.project[':projectId'].$delete({ param: { projectId } }),
    onSuccess: () => { setActiveProject(null); setConfirm(false) },
  })

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
        onOpenChange={(next) => { setConfirm(next); remove.reset() }}
        busy={remove.isPending}
        error={remove.error?.message}
        title="Remove project?"
        description={`Removes "${name}" and all its workspaces. This can't be undone.`}
        confirmText={remoteUrl}
        confirmLabel="Remove"
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
