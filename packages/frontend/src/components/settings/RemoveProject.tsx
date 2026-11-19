import { useState, type JSX } from 'react'
import { removeProjectInBackground } from '#lib/projectOps'
import { useUiStore } from '#lib/store'
import { useHasVolumes, useVolumes } from '#lib/volumes'
import type { ProjectSummary } from '@yaac/shared/types'
import { YButton, YConfirm, YSettingRow } from '#ui'

/** Remove the project, after a confirmation that names its volumes, whose
 *  data goes with it though no workspace holds them, and says its repos
 *  stay. On a server with volumes, confirm waits for their list, so a slow
 *  or failed one cannot hide the warning. Settings closes and the project
 *  is selected, so the main area shows the removal's progress
 *  (#lib/projectOps). */
export function RemoveProject({ project }: { project: ProjectSummary }): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const { id: projectId, name } = project
  const list = useVolumes(confirm ? projectId : null)
  const checking = useHasVolumes() && list === undefined
  const volumes = list ?? []
  const remove = (): void => {
    setConfirm(false)
    const { closeSettings, setActiveProject } = useUiStore.getState()
    closeSettings()
    setActiveProject(projectId)
    removeProjectInBackground(projectId, name)
  }

  return (
    <YSettingRow label="Remove project" hint="Stops and deletes all of its workspaces.">
      <YButton variant="danger" size="sm" onClick={() => setConfirm(true)}>Remove project</YButton>
      <YConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove project?"
        description={`Removes "${name}" and all its workspaces, with their uncommitted and unpushed work. `
          + (project.repos.length > 0
            ? `Its ${project.repos.length === 1 ? 'repo stays' : 'repos stay'} in Settings → Repos, to link again or delete. `
            : '')
          + (checking ? 'Checking its volumes… ' : '')
          + (volumes.length > 0
            ? `Its ${volumes.length === 1 ? 'volume' : `${String(volumes.length)} volumes`} `
              + `(${volumes.map((v) => v.name).join(', ')}) and all their data go too. `
            : '')
          + 'This can\'t be undone.'}
        confirmText={name}
        confirmLabel="Remove"
        blocked={checking}
        onConfirm={remove}
      />
    </YSettingRow>
  )
}
