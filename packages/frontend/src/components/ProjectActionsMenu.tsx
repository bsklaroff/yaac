import { useState, type JSX } from 'react'
import { DeleteIcon, SettingsIcon } from '#lib/icons'
import { removeProjectInBackground } from '#lib/projectOps'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import { useVolumes } from '#lib/volumes'
import type { ProjectSummary } from '@yaac/shared/types'
import { YConfirm, YMenu, YMenuItem, YMenuPopup } from '#ui'

/** The project name as a menu trigger: Project settings, which opens the
 *  settings modal on this project's General page, and Remove, which asks
 *  for confirmation and then runs in the background (#lib/projectOps).
 *  The confirmation names the project's volumes, whose data goes with it
 *  though no workspace holds them, and says its repos stay. A teammate's
 *  project shows its plain name. */
export function ProjectActionsMenu({ project }: { project: ProjectSummary }): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const { id: projectId, name } = project
  const readOnly = useReadOnly()
  const volumes = useVolumes(confirm ? projectId : null) ?? []
  const openProjectSettings = (): void => {
    const { openSettings, setSettingsProjectId } = useUiStore.getState()
    openSettings('project-general')
    setSettingsProjectId(projectId)
  }
  if (readOnly) return <span className="truncate font-semibold tracking-tight">{name}</span>

  return (
    <>
      <YMenu.Root>
        <YMenu.Trigger className="-ml-2 flex min-w-0 items-center rounded-md px-2 py-1 font-semibold
          tracking-tight text-text outline-none transition hover:bg-hover data-[popup-open]:bg-selected">
          <span className="truncate">{name}</span>
        </YMenu.Trigger>
        <YMenuPopup side="bottom" align="start" sideOffset={6} className="min-w-[170px]">
          <YMenuItem icon={SettingsIcon} onClick={openProjectSettings}>Project settings…</YMenuItem>
          <YMenuItem icon={DeleteIcon} danger onClick={() => setConfirm(true)}>Remove project</YMenuItem>
        </YMenuPopup>
      </YMenu.Root>

      <YConfirm
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
