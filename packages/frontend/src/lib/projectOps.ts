import type { QueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore, type ProjectOp } from '#lib/store'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { projectNameFor } from '@yaac/shared/project-name'
import type { ProjectAddEntry } from '@yaac/shared/types'

/*
 * Project add and remove run in the background: a clone can take minutes and
 * a remove stops every workspace, so the dialog that started one closes at
 * once and the op's progress shows in the rail and the main area instead
 * (`ProjectOp` in #lib/store). An add picks its project's id up front, so
 * the server lists it under that id (`projectAdds`) and a reload finds it.
 */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
  const id = crypto.randomUUID()
  const state = useUiStore.getState()
  state.putProjectOp({ id, kind: 'add', name, remoteUrl })
  state.setActiveProject(id)
  api.project.add.$post({ json: { remoteUrl, gitCredentialId, projectId: id } }).then(
    ({ knownHostsEntry }) => {
      // Refresh the credential's repo list.
      void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
      if (knownHostsEntry !== null) useUiStore.getState().pushTrustedHostKey({ projectName: name, entry: knownHostsEntry })
    },
    (e: unknown) => useUiStore.getState().patchProjectOp(id, { error: errorText(e) }),
  )
}

/** Create an empty project whose remote yaac hosts, shown as an add in
 *  progress like `addProjectInBackground`. */
export function createProjectInBackground(name: string): void {
  const id = crypto.randomUUID()
  const state = useUiStore.getState()
  state.putProjectOp({ id, kind: 'add', name: projectNameFor(name) || name, remoteUrl: '', hosted: true })
  state.setActiveProject(id)
  api.project.create.$post({ json: { name, projectId: id } }).catch(
    (e: unknown) => useUiStore.getState().patchProjectOp(id, { error: errorText(e) }),
  )
}

/** Clear a failed add, from this tab and from the server's list. */
export function dismissProjectAdd(id: string): void {
  useUiStore.getState().dropProjectOp(id)
  void api.project.add[':projectId'].dismiss.$post({ param: { projectId: id } }).catch(() => undefined)
}

/** Remove a project and every workspace in it. */
export function removeProjectInBackground(projectId: string, name: string): void {
  useUiStore.getState().putProjectOp({ id: projectId, kind: 'remove', name, remoteUrl: '' })
  api.project[':projectId'].$delete({ param: { projectId } }).then(
    () => useUiStore.getState().patchProjectOp(projectId, { done: true }),
    (e: unknown) => useUiStore.getState().patchProjectOp(projectId, { error: errorText(e) }),
  )
}

/**
 * The server's adds, each standing over this tab's op of the same id (the
 * server's progress and error are the truth), then this tab's other ops.
 */
export function mergeProjectOps(adds: ProjectAddEntry[], ops: ProjectOp[]): ProjectOp[] {
  const listed = new Set(adds.map((a) => a.id))
  return [
    ...adds.map((a): ProjectOp => ({
      id: a.id,
      kind: 'add',
      name: a.name,
      remoteUrl: a.remoteUrl,
      hosted: a.hosted,
      ...(a.progress !== undefined && { progress: a.progress }),
      ...(a.error !== undefined && { error: a.error }),
    })),
    ...ops.filter((o) => !listed.has(o.id)),
  ]
}
