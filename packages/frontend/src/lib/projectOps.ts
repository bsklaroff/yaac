import type { QueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import { AUTH_LIST_KEY } from '#lib/useAuthList'

/*
 * Project add and remove run in the background: a clone can take minutes and
 * a remove stops every workspace, so the dialog that started one closes at
 * once and the op's progress shows in the rail and the main area instead
 * (`ProjectOp` in #lib/store).
 */

let nextAddKey = 0

/**
 * Clone `remoteUrl` as a new project and select its pending entry. An SSH
 * clone queues the host key it trusted for the add dialog to show.
 */
export function addProjectInBackground(
  remoteUrl: string,
  name: string,
  gitCredentialId: string,
  queryClient: QueryClient,
): void {
  const id = `adding-${nextAddKey++}`
  const state = useUiStore.getState()
  state.putProjectOp({ id, kind: 'add', name, remoteUrl })
  state.setActiveProject(id)
  api.project.add.$post({ json: { remoteUrl, gitCredentialId } }).then(
    ({ project, knownHostsEntry }) => {
      // Refresh the credential's project list.
      void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
      useUiStore.getState().patchProjectOp(id, { doneId: project.id })
      if (knownHostsEntry !== null) useUiStore.getState().pushTrustedHostKey({ projectName: name, entry: knownHostsEntry })
    },
    (e: unknown) => useUiStore.getState().patchProjectOp(id, { error: e instanceof Error ? e.message : String(e) }),
  )
}

/** Remove a project and every workspace in it. */
export function removeProjectInBackground(projectId: string, name: string, remoteUrl: string): void {
  useUiStore.getState().putProjectOp({ id: projectId, kind: 'remove', name, remoteUrl })
  api.project[':projectId'].$delete({ param: { projectId } }).then(
    () => useUiStore.getState().patchProjectOp(projectId, { doneId: projectId }),
    (e: unknown) => useUiStore.getState().patchProjectOp(projectId, {
      error: e instanceof Error ? e.message : String(e),
    }),
  )
}
