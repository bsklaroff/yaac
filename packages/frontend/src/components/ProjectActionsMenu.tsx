import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { DeleteIcon } from '#lib/icons'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { removeProjectInBackground } from '#lib/projectOps'
import { useReadOnly } from '#lib/viewer'
import { useVolumes } from '#lib/volumes'
import type { ProjectSummary } from '@yaac/shared/types'

/** The project name as a menu trigger. The only action is Remove, which
 *  asks for confirmation and then runs in the background (#lib/projectOps).
 *  The confirmation names the project's volumes, whose data goes with it
 *  though no workspace holds them, and says its repos stay. A teammate's
 *  project shows its plain name. */
export function ProjectActionsMenu({ project }: { project: ProjectSummary }): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const { id: projectId, name } = project
  const readOnly = useReadOnly()
  const volumes = useVolumes(confirm ? projectId : null) ?? []
  if (readOnly) return <span className="truncate font-semibold tracking-tight">{name}</span>

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="-ml-2 flex min-w-0 items-center rounded-md px-2 py-1 font-semibold
          tracking-tight text-text outline-none transition hover:bg-surface-2 data-[popup-open]:bg-surface-2">
          <span className="truncate">{name}</span>
        </Menu.Trigger>
        <MenuPopup side="bottom" align="start" sideOffset={6} className="min-w-[170px]">
          <Menu.Item
            className={clsx(MENU_ITEM, 'text-danger data-[highlighted]:bg-[#c94a4a]/15 data-[highlighted]:text-danger')}
            onClick={() => setConfirm(true)}
          >
            <DeleteIcon size={14} />
            Remove project
          </Menu.Item>
        </MenuPopup>
      </Menu.Root>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove project?"
        description={`Removes "${name}" and all its workspaces, with their uncommitted and unpushed work. `
          + (project.repos.length > 0
            ? `Its ${project.repos.length === 1 ? 'repo stays' : 'repos stay'} in Settings → Repos, to link again or delete. `
            : '')
          + (volumes.length > 0
            ? `Its ${volumes.length === 1 ? 'volume' : `${String(volumes.length)} volumes`} `
              + `(${volumes.map((v) => v.name).join(', ')}) and all their data go too. `
            : '')
          + 'This can\'t be undone.'}
        confirmText={name}
        confirmLabel="Remove"
        onConfirm={() => { setConfirm(false); removeProjectInBackground(projectId, name) }}
      />
    </>
  )
}
